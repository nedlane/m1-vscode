// Verifies the pinned m1-lsp server release exists and ships the per-platform
// server binaries that scripts/fetch-server.mjs (and the m1-lsp release.yml)
// expect. Run in CI so a stale, typo'd, or asset-less pin — e.g. a release that
// was tagged before its binaries were uploaded — fails fast here instead of
// breaking `server:fetch` or the per-platform VSIX build at release time.
//
//   node scripts/verify-server-pin.mjs
//
// Requires the GitHub CLI (`gh`), which is preinstalled on GitHub runners.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
).m1;
const repo = cfg?.serverRepo;
const version = cfg?.serverVersion;

// The targets m1-lsp's release.yml builds and uploads; fetch-server.mjs pulls
// `m1-lsp-<target>` (with `.exe` on Windows) for the host platform.
const requiredAssets = [
  "m1-lsp-x86_64-unknown-linux-gnu",
  "m1-lsp-aarch64-apple-darwin",
  "m1-lsp-x86_64-pc-windows-msvc.exe",
];

if (!repo || !version) {
  console.error(
    "Missing pin: set package.json m1.serverRepo and m1.serverVersion.",
  );
  process.exit(1);
}

let assets;
try {
  const out = execFileSync(
    "gh",
    [
      "release",
      "view",
      version,
      "--repo",
      repo,
      "--json",
      "assets",
      "-q",
      ".assets[].name",
    ],
    { encoding: "utf8" },
  );
  assets = out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
} catch {
  console.error(
    `::error::Pinned server release ${version} not found in ${repo}.`,
  );
  process.exit(1);
}

console.log(
  `Pinned ${repo}@${version} — assets: ${assets.length ? assets.join(", ") : "(none)"}`,
);

const missing = requiredAssets.filter((a) => !assets.includes(a));
if (missing.length) {
  console.error(
    `::error::${repo}@${version} is missing server binaries: ${missing.join(", ")}. ` +
      `fetch-server.mjs and the VSIX release build would fail. Re-run the m1-lsp release ` +
      `workflow for ${version} so the binaries are uploaded, or repin to a release that has them.`,
  );
  process.exit(1);
}

console.log("OK: pinned release has all required server binaries.");
