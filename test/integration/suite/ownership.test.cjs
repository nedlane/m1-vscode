const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");
const fs = require("node:fs");
const os = require("node:os");
const { buildSync } = require("esbuild");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "m1-selector-test-"));
const bundle = path.join(work, "ownership.cjs");
buildSync({
  entryPoints: [path.resolve(__dirname, "../../../src/project-ownership.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  logLevel: "silent",
});
const { ownedPatterns: compilePatterns } = require(bundle);
const ownedPatterns = (roots) =>
  compilePatterns(roots.map((root) => root.split("/")));
exports.run = async function () {
  const base = path.join(os.tmpdir(), "owned-glob-proof");
  const segments = [
    "nested",
    "nest",
    "nested2",
    "x",
    "x/y",
    "A/B",
    "A/C",
    "A/other",
    ".hidden",
    "!a",
    "[x]",
    "x]y",
    "{a}",
    "a{",
    "a}",
    "a,b",
    "*a",
    "?a",
    "a-b",
    "^a",
    "😀",
    "😀sub",
    "😀suffix",
    "é",
    "é",
    "中",
    "|",
    "~",
    "0",
    ".x",
    "[",
    "]",
    "{",
    "}",
    "*",
    "?",
    "-",
    "^",
    "!",
    "a\\b",
    "\\",
  ];
  let checks = 0;
  const match = (root, pattern, file) =>
    vscode.languages.match(
      {
        scheme: "file",
        language: "m1scr",
        pattern: new vscode.RelativePattern(
          vscode.Uri.parse(vscode.Uri.file(root).toString()),
          pattern,
        ),
      },
      { uri: vscode.Uri.file(file), languageId: "m1scr" },
    ) > 0;
  const sets = [
    ["nested"],
    ["nested", "nest", "A/B", "A/C"],
    segments.filter((s) => s !== ".x"),
    ["😀", "😀sub"],
    ["{a}", "a{", "a}", "[x]", "x]y"],
  ];
  for (const excluded of sets) {
    const patterns = ownedPatterns(excluded);
    const names = [
      ...segments,
      ...segments.map((s) => s + "2"),
      ...segments.map((s) => "a/" + s),
      ...segments.map((s) => s + "/child"),
    ];
    for (const name of ["", ...names]) {
      const relative = path.posix.join(name, "Main.m1scr");
      const expected = !excluded.some((root) =>
        relative.startsWith(root + "/"),
      );
      const matching = patterns.filter((p) =>
        match(path.join(base, p.base), p.pattern, path.join(base, relative)),
      );
      assert.equal(
        matching.length > 0,
        expected,
        JSON.stringify({ excluded, relative, matching, patterns }),
      );
      checks++;
    }
  }

  const chars = [
    "a",
    "n",
    ".",
    "0",
    "\\",
    "[",
    "]",
    "{",
    "}",
    "*",
    "?",
    "-",
    "^",
    "!",
    ",",
    "|",
    "~",
    "😀",
  ];
  let seed = 8741;
  const pick = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return chars[seed % chars.length];
  };
  const name = () => {
    let n = pick() + pick() + pick();
    return n === "." || n === ".." ? "safe" : n;
  };
  for (let batch = 0; batch < 40; batch++) {
    const excluded = Array.from({ length: 4 }, name);
    const patterns = ownedPatterns(excluded);
    const names = [
      ...excluded,
      ...excluded.map((n) => n + "x"),
      ...excluded.map((n) => n.slice(0, 2)),
      ...Array.from({ length: 40 }, name),
      ...excluded.map((n) => n.replaceAll("\\", "/")),
    ];
    for (const n of names) {
      // A truncated surrogate is not a representable file URI.
      try {
        encodeURIComponent(n);
      } catch {
        continue;
      }
      const relative = path.posix.join(n, "Main.m1scr");
      if (relative.startsWith("../")) continue;
      const expected = !excluded.some((root) =>
        relative.startsWith(root + "/"),
      );
      const matching = patterns.filter((p) =>
        match(path.join(base, p.base), p.pattern, path.join(base, relative)),
      );
      assert.equal(
        matching.length > 0,
        expected,
        JSON.stringify({ excluded, relative, matching, patterns }),
      );
      checks++;
    }
  }

  console.log(`actual VS Code glob checks: ${checks}`);
};
suite("nested project selector matching", () => {
  test("partitions punctuation unicode and backslash paths", exports.run);
  suiteTeardown(() => fs.rmSync(work, { recursive: true, force: true }));
});
