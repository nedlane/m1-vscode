import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  throw new Error("Build provenance verification failed");
}

/** Install a release binary only after its checksum and provenance pass. */
export function fetchReleaseAsset({
  repo,
  version,
  asset,
  outFile,
  executable,
}) {
  const temporary = fs.mkdtempSync(
    path.join(path.dirname(outFile), ".m1-download-"),
  );
  try {
    const download = (name) => {
      const file = path.join(temporary, name);
      execFileSync(
        "gh",
        [
          "release",
          "download",
          version,
          "--repo",
          repo,
          "--pattern",
          name,
          "--output",
          file,
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
      );
      return file;
    };
    const binary = download(asset);
    const manifest = fs.readFileSync(download("SHA256SUMS"), "utf8");
    const entries = manifest
      .split(/\r?\n/)
      .map((line) => /^([a-fA-F0-9]{64})\s+\*?([^/\\]+)$/.exec(line))
      .filter((match) => match && match[2] === asset);
    if (entries.length !== 1) {
      throw new Error(`Expected one SHA256SUMS entry for ${asset}`);
    }
    const actual = createHash("sha256")
      .update(fs.readFileSync(binary))
      .digest("hex");
    if (actual !== entries[0][1].toLowerCase()) {
      throw new Error(`SHA256SUMS mismatch for ${asset}`);
    }
    verifyProvenance(binary, repo);
    if (executable) fs.chmodSync(binary, 0o755);
    fs.renameSync(binary, outFile);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
