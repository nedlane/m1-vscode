// Fetches the pinned m1-fmt binary from its GitHub Release into server/.
// Replaces any manual `cp` of a locally-built binary.
//
// Version + repo are pinned in package.json under "m1": { fmtRepo, fmtVersion }.
// Auth: uses the `gh` CLI (honours GH_TOKEN) when available; m1-fmt's repo is
// public, so an unauthenticated download also works.
//
// Usage:
//   node scripts/fetch-lint.mjs                 # current platform, pinned version
//   node scripts/fetch-lint.mjs --target x86_64-pc-windows-msvc
//   node scripts/fetch-lint.mjs --version v0.2.0 --out server
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

  throw new Error(
    `Provenance verification FAILED for ${file} (repo ${repo}):\n${out}`,
  );
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

const repo = arg("repo", cfg.fmtRepo);
const version = arg("version", cfg.fmtVersion);
const target = arg("target", defaultTarget());
const outDir = path.resolve(root, arg("out", "server"));

if (!repo || !version) {
  console.error(
    "Missing pin: set package.json m1.fmtRepo and m1.fmtVersion (or pass --repo/--version).",
  );
  process.exit(1);
}

const isWindows = target.includes("windows");
const asset = `m1-fmt-${target}${isWindows ? ".exe" : ""}`;
const outFile = path.join(outDir, `m1-fmt${isWindows ? ".exe" : ""}`);

fs.mkdirSync(outDir, { recursive: true });

console.log(`Fetching ${asset} from ${repo}@${version} -> ${outFile}`);
const staging = fs.mkdtempSync(
  path.join(outDir, `.${path.basename(outFile)}-`),
);
const downloaded = path.join(staging, path.basename(outFile));
try {
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
        downloaded,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
  } catch (err) {
    throw new Error(
      `Failed to download ${asset}. Confirm the release ${version} exists in ${repo} ` +
        `and that gh is authenticated (GH_TOKEN) with access.\n${String(err)}`,
    );
  }
  verifyProvenance(downloaded, repo);
  if (!isWindows) {
    fs.chmodSync(downloaded, 0o755);
  }
  // Staging is on the destination filesystem; replacement preserves the old
  // executable until the new bytes pass verification and permission setup.
  fs.renameSync(downloaded, outFile);
  console.log("Done.");
} catch (err) {
  console.error(String(err));
  process.exitCode = 1;
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
