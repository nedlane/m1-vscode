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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchReleaseAsset } from "./fetch-release-asset.mjs";

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
try {
  fetchReleaseAsset({ repo, version, asset, outFile, executable: !isWindows });
} catch (err) {
  console.error(
    `\nFailed to download ${asset}. Confirm the release ${version} exists in ${repo} ` +
      `and that gh is authenticated (GH_TOKEN) with access.\n${String(err)}`,
  );
  process.exit(1);
}

console.log("Done.");
