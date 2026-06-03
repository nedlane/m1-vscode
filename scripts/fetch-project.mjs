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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

if (!isWindows) {
  fs.chmodSync(outFile, 0o755);
}
console.log("Done.");
