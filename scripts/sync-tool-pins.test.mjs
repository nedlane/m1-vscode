import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { resolvePins, validateRelease } from "./sync-tool-pins.mjs";

function fixture(tool, tag = "v1.2.3") {
  const names = [
    "aarch64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "x86_64-pc-windows-msvc.exe",
  ].map((target) => `${tool}-${target}`);
  const checksum = "a".repeat(64);
  const sums = names.map((name) => `${checksum}  ${name}\n`).join("");
  return {
    release: {
      tag_name: tag,
      assets: [
        ...names.map((name) => ({
          name,
          digest: `sha256:${checksum}`,
          state: "uploaded",
          size: 1,
        })),
        {
          name: "SHA256SUMS",
          state: "uploaded",
          size: Buffer.byteLength(sums),
          digest: `sha256:${createHash("sha256").update(sums).digest("hex")}`,
        },
      ],
    },
    sums,
  };
}

test("complete three-platform stable release is accepted", () => {
  const { release, sums } = fixture("m1-fmt");
  assert.equal(validateRelease("m1-fmt", release, sums), "v1.2.3");
});
test("missing platforms, missing checksums, mismatched digests and unsafe tags fail", () => {
  for (const mutate of [
    (f) => f.release.assets.shift(),
    (f) => f.release.assets.pop(),
    (f) => {
      f.release.assets[0].digest = `sha256:${"b".repeat(64)}`;
    },
    (f) => {
      f.sums += "invalid checksum\n";
    },
    (f) => {
      f.release.tag_name = "v1$(touch injected)";
    },
    (f) => {
      f.release.prerelease = true;
    },
  ]) {
    const f = fixture("m1-fmt");
    mutate(f);
    assert.throws(() => validateRelease("m1-fmt", f.release, f.sums));
  }
});
test("a formatter-only release is proposed even when LSP is unchanged", () => {
  const pkg = { m1: {} };
  const tools = {
    server: "m1-lsp",
    fmt: "m1-fmt",
    lint: "m1-lint",
    project: "m1-project",
  };
  for (const key of Object.keys(tools)) {
    pkg.m1[`${key}Repo`] = `owner/${tools[key]}`;
    pkg.m1[`${key}Version`] = "v1.2.3";
  }
  const pins = resolvePins(pkg, (repo) =>
    fixture(repo.split("/")[1], repo.endsWith("m1-fmt") ? "v1.2.4" : "v1.2.3"),
  );
  assert.deepEqual(
    pins.filter((pin) => pin.previous !== pin.latest).map((pin) => pin.tool),
    ["m1-fmt"],
  );
  assert.equal(pkg.m1.fmtVersion, "v1.2.3");
});

test("a latest backport cannot downgrade a bundled tool", () => {
  const pkg = { m1: {} };
  const tools = {
    server: "m1-lsp",
    fmt: "m1-fmt",
    lint: "m1-lint",
    project: "m1-project",
  };
  for (const key of Object.keys(tools)) {
    pkg.m1[`${key}Repo`] = `owner/${tools[key]}`;
    pkg.m1[`${key}Version`] = key === "fmt" ? "v1.10.0" : "v1.2.3";
  }
  const pins = resolvePins(pkg, (repo) =>
    fixture(repo.split("/")[1], repo.endsWith("m1-fmt") ? "v1.9.99" : "v1.2.3"),
  );
  assert.equal(pins.find((pin) => pin.tool === "m1-fmt").latest, "v1.10.0");
  assert.equal(
    pins.find((pin) => pin.tool === "m1-fmt").ignoredOlderRelease,
    "v1.9.99",
  );
  assert.equal(pins.filter((pin) => pin.previous !== pin.latest).length, 0);
});

test("pending, empty and duplicate required assets are incomplete releases", () => {
  for (const mutate of [
    (f) => {
      f.release.assets[0].state = "starter";
      delete f.release.assets[0].digest;
    },
    (f) => {
      f.release.assets[0].size = 0;
      delete f.release.assets[0].digest;
    },
    (f) => {
      f.release.assets.push({ ...f.release.assets[0] });
    },
    (f) => {
      f.release.assets.at(-1).state = "starter";
    },
    (f) => {
      f.release.assets.at(-1).size = 0;
    },
  ]) {
    const f = fixture("m1-fmt");
    mutate(f);
    assert.throws(() => validateRelease("m1-fmt", f.release, f.sums));
  }
});
