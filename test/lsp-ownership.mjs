import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "m1-client-ownership-"));
try {
  const shim = path.join(work, "shim.cjs");
  fs.writeFileSync(
    shim,
    "const {pathToFileURL}=require('node:url');module.exports={Uri:{file:fsPath=>({fsPath,toString:()=>pathToFileURL(fsPath).href})}}",
  );
  const bundle = path.join(work, "client.cjs");
  await build({
    stdin: {
      contents:
        'export { buildDocumentSelector } from "./src/lsp-client"; export { owningRoot, containsPath } from "./src/project-ownership";',
      resolveDir: process.cwd(),
      loader: "ts",
    },
    outfile: bundle,
    bundle: true,
    platform: "node",
    logLevel: "silent",
    alias: { vscode: shim, "vscode-languageclient/node": shim },
  });
  const { buildDocumentSelector, owningRoot, containsPath } = require(bundle);
  const uri = (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` });
  const roots = [
    path.join(work, "a"),
    path.join(work, "a/nested"),
    path.join(work, "a/nested/deeper"),
    path.join(work, "b"),
  ];
  for (const relative of [
    "a/Main.m1scr",
    "a/nested/Main.m1scr",
    "a/nested/deeper/Main.m1scr",
    "a/nested2/Main.m1scr",
    "a/nest/Main.m1scr",
    "a/other/new/Main.m1scr",
    "b/Main.m1scr",
    "b2/Main.m1scr",
  ]) {
    const file = path.join(work, relative);
    const expected = roots
      .filter((root) => file.startsWith(root + path.sep))
      .sort((a, b) => b.length - a.length)[0];
    assert.equal(owningRoot(roots, file), expected, relative);
    for (const root of roots) {
      const selector = buildDocumentSelector(uri(root), true, roots);
      assert(selector.length);
      assert(
        selector.every((filter) =>
          filter.pattern.baseUri.startsWith(uri(root).toString()),
        ),
      );
    }
  }
  assert.deepEqual(buildDocumentSelector(undefined, false), [
    { scheme: "file", language: "m1scr" },
    { scheme: "untitled", language: "m1scr" },
  ]);
  assert(containsPath(roots[0], roots[0]));
  assert(!containsPath(roots[0], roots[0] + "2"));
  console.log(
    "parent, nested, grandchild and sibling selectors have one owner",
  );
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
