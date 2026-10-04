import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tools = {
  server: "m1-lsp",
  fmt: "m1-fmt",
  lint: "m1-lint",
  project: "m1-project",
};
const targets = [
  "aarch64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc.exe",
];

// Refuse an in-progress or incomplete release: a tag alone is not installable.
export function validateRelease(tool, release, sums) {
  if (
    !/^v\d+\.\d+\.\d+$/.test(release.tag_name) ||
    release.draft ||
    release.prerelease
  ) {
    throw new Error(`${tool}: expected a published stable vX.Y.Z release`);
  }
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  const manifest = assets.get("SHA256SUMS");
  if (!manifest) throw new Error(`${tool}: release lacks SHA256SUMS`);
  if (
    manifest.digest &&
    manifest.digest !==
      `sha256:${createHash("sha256").update(sums).digest("hex")}`
  ) {
    throw new Error(`${tool}: SHA256SUMS digest mismatch`);
  }
  const checksums = new Map();
  for (const line of sums.split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?([^/\\]+)$/.exec(line);
    if (!match || checksums.has(match[2]))
      throw new Error(`${tool}: invalid or duplicate checksum entry`);
    checksums.set(match[2], match[1].toLowerCase());
  }
  for (const target of targets) {
    const name = `${tool}-${target}`;
    const asset = assets.get(name);
    const checksum = checksums.get(name);
    if (!asset || !checksum)
      throw new Error(`${tool}: release lacks binary/checksum for ${name}`);
    if (asset.digest && asset.digest !== `sha256:${checksum}`) {
      throw new Error(
        `${tool}: asset digest disagrees with SHA256SUMS for ${name}`,
      );
    }
  }
  return release.tag_name;
}

export function resolvePins(pkg, readRelease) {
  return Object.entries(tools).map(([key, tool]) => {
    const repo = pkg.m1[`${key}Repo`];
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))
      throw new Error(`Invalid repository for ${tool}`);
    const { release, sums } = readRelease(repo);
    const previous = pkg.m1[`${key}Version`];
    if (!/^v\d+\.\d+\.\d+$/.test(previous))
      throw new Error(`${tool}: invalid existing version pin`);
    const candidate = validateRelease(tool, release, sums);
    const currentParts = previous.slice(1).split(".").map(BigInt);
    const candidateParts = candidate.slice(1).split(".").map(BigInt);
    let comparison = 0;
    for (let index = 0; index < 3; index++) {
      if (candidateParts[index] !== currentParts[index]) {
        comparison = candidateParts[index] > currentParts[index] ? 1 : -1;
        break;
      }
    }
    // GitHub may mark an older backport as latest; never downgrade a bundle.
    return {
      key,
      tool,
      previous,
      latest: comparison < 0 ? previous : candidate,
      ...(comparison < 0 ? { ignoredOlderRelease: candidate } : {}),
    };
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "m1-tool-pins-"));
  try {
    const pins = resolvePins(pkg, (repo) => {
      const release = JSON.parse(
        execFileSync("gh", ["api", `repos/${repo}/releases/latest`], {
          encoding: "utf8",
        }),
      );
      const directory = path.join(temporary, repo.replace("/", "-"));
      fs.mkdirSync(directory);
      // Validate the tag before passing it to any command, even without shell interpolation.
      if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name))
        throw new Error(`Invalid release tag for ${repo}`);
      execFileSync("gh", [
        "release",
        "download",
        release.tag_name,
        "--repo",
        repo,
        "--pattern",
        "SHA256SUMS",
        "--dir",
        directory,
      ]);
      return {
        release,
        sums: fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8"),
      };
    });
    const changes = pins.filter((pin) => pin.latest !== pin.previous);
    if (process.argv.includes("--write") && changes.length) {
      for (const pin of changes) pkg.m1[`${pin.key}Version`] = pin.latest;
      fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
    }
    process.stdout.write(
      `${JSON.stringify({ changed: changes.length > 0, pins, changes }, null, 2)}\n`,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
