// Fetches the pinned m1-project binary from its GitHub Release into server/.
// Replaces any manual `cp` of a locally-built binary.
//
// Version + repo are pinned in package.json under "m1": { serverRepo, serverVersion }.
// Auth: uses the `gh` CLI (honours GH_TOKEN), so it works for the private m1-lsp repo.
//
// Usage:
//   node scripts/fetch-server.mjs                 # current platform, pinned version
//   node scripts/fetch-server.mjs --target x86_64-pc-windows-msvc
//   node scripts/fetch-server.mjs --version v0.2.0 --out server
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Verify GitHub build provenance for a downloaded release asset before we trust
// (and later bundle/spawn) it. The producer repos sign their release binaries
// with actions/attest-build-provenance; `gh attestation verify` checks the
// Sigstore bundle against the asset's digest and the producing repo.
//
// Policy during rollout:
//   - attestation present + valid -> OK
//   - attestation present + invalid -> FAIL (tampering / wrong producer)
//   - no attestation yet (older releases) -> WARN and proceed
//   - gh missing / no GH auth -> WARN and proceed (documented fallback: callers
//     without gh should pin + check SHA-256 out of band)
// This makes verification enforcing wherever provenance exists without breaking
// the build for releases cut before the producers started attesting.
function verifyProvenance(file, repo) {
  const gh = spawnSync("gh", ["attestation", "verify", file, "--repo", repo], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });

  if (gh.error && gh.error.code === "ENOENT") {
    console.warn(
      `WARN: 'gh' not found — cannot verify build provenance of ${file}. ` +
        `Proceeding unverified. Install gh, or verify a pinned SHA-256 out of band.`,
    );
    return;
  }

  const out = `${gh.stdout ?? ""}${gh.stderr ?? ""}`;
  if (gh.status === 0) {
    console.log(`Provenance verified for ${file} (repo ${repo}).`);
    return;
  }

  // gh exits non-zero both when no attestation exists yet and when an existing
  // attestation fails to verify. Treat "no attestation found" as a soft warning
  // (rollout) but a genuine verification failure as fatal (tampering signal).
  const noAttestation =
    /no attestations? found/i.test(out) ||
    /could not find any attestations/i.test(out) ||
    // gh surfaces a missing attestation as a 404 on the attestations API
    // endpoint — that means the release predates provenance, not tampering.
    (/HTTP 404/i.test(out) && /attestations/i.test(out));
  if (noAttestation) {
    console.warn(
      `WARN: no build provenance attestation found for ${file} (repo ${repo}). ` +
        `This is expected for releases cut before provenance rollout; proceeding.`,
    );
    return;
  }

  console.error(
    `\nProvenance verification FAILED for ${file} (repo ${repo}):\n${out}`,
  );
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
);
const cfg = pkg.m1 ?? {};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Map the host platform to a Rust target triple when --target is not given.
function defaultTarget() {
  const key = `${process.platform}-${process.arch}`;
  const map = {
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
  };
  const t = map[key];
  if (!t) {
    throw new Error(`unsupported host platform: ${key}`);
  }
  return t;
}

const repo = arg("repo", cfg.projectRepo);
const version = arg("version", cfg.projectVersion);
const target = arg("target", defaultTarget());
const outDir = path.resolve(root, arg("out", "server"));

if (!repo || !version) {
  console.error(
    "Missing pin: set package.json m1.projectRepo and m1.projectVersion (or pass --repo/--version).",
  );
  process.exit(1);
}

const isWindows = target.includes("windows");
const asset = `m1-project-${target}${isWindows ? ".exe" : ""}`;
const outFile = path.join(outDir, `m1-project${isWindows ? ".exe" : ""}`);

fs.mkdirSync(outDir, { recursive: true });

console.log(`Fetching ${asset} from ${repo}@${version} -> ${outFile}`);
try {
  execFileSync(
    "gh",
    [
      "release",
      "download",
      version,
      "--repo",
      repo,
      "--pattern",
      asset,
      "--output",
      outFile,
      "--clobber",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
} catch (err) {
  console.error(
    `\nFailed to download ${asset}. Confirm the release ${version} exists in ${repo} ` +
      `and that gh is authenticated (GH_TOKEN) with access.\n${String(err)}`,
  );
  process.exit(1);
}

// Verify build provenance before trusting the binary (chmod +x / bundle).
verifyProvenance(outFile, repo);

if (!isWindows) {
  fs.chmodSync(outFile, 0o755);
}
console.log("Done.");
