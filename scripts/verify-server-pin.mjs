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

// Verifies one pinned release exists and ships every per-platform binary that
// the matching fetch-*.mjs (and the producer's release.yml) expect. `tool` is
// the asset/binary basename ("m1-lsp" or "m1-project").
function verifyPin({ label, repo, version, tool }) {
  if (!repo || !version) {
    console.error(`::error::Missing ${label} pin in package.json m1.`);
    return false;
  }

  // The targets the producer's release.yml builds and uploads; fetch-*.mjs
  // pulls `<tool>-<target>` (with `.exe` on Windows) for the host platform.
  const requiredAssets = [
    `${tool}-x86_64-unknown-linux-gnu`,
    `${tool}-aarch64-apple-darwin`,
    `${tool}-x86_64-pc-windows-msvc.exe`,
  ];

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
      `::error::Pinned ${label} release ${version} not found in ${repo}.`,
    );
    return false;
  }

  console.log(
    `Pinned ${repo}@${version} — assets: ${assets.length ? assets.join(", ") : "(none)"}`,
  );

  const missing = requiredAssets.filter((a) => !assets.includes(a));
  if (missing.length) {
    console.error(
      `::error::${repo}@${version} is missing ${tool} binaries: ${missing.join(", ")}. ` +
        `fetch-*.mjs and the VSIX release build would fail. Re-run the ${tool} release ` +
        `workflow for ${version} so the binaries are uploaded, or repin to a release that has them.`,
    );
    return false;
  }

  console.log(`OK: pinned ${label} release has all required binaries.`);
  return true;
}

const ok = [
  verifyPin({
    label: "m1-lsp server",
    repo: cfg?.serverRepo,
    version: cfg?.serverVersion,
    tool: "m1-lsp",
  }),
  verifyPin({
    label: "m1-project",
    repo: cfg?.projectRepo,
    version: cfg?.projectVersion,
    tool: "m1-project",
  }),
].every(Boolean);

process.exit(ok ? 0 : 1);
