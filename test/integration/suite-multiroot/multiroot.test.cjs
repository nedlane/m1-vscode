// Multi-root workspace (#20): the workspace lists two separate M1 projects
// (multiroot/a, multiroot/b). The extension must start one language server per
// project root, each serving its own folder — so hover works on a file in *each*
// project, not just the first.
const assert = require("assert");
const path = require("path");
const vscode = require("vscode");

const EXT_ID = "m1-tooling.m1-vscode";

async function retry(fn, { tries = 30, delay = 1000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  if (last) throw last;
  return undefined;
}

async function hoverText(file) {
  const doc = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(doc);
  // Cursor on the `local` name (line 0, the identifier after `local `).
  const pos = new vscode.Position(0, 6);
  const hovers = await retry(async () => {
    const h = await vscode.commands.executeCommand(
      "vscode.executeHoverProvider",
      doc.uri,
      pos,
    );
    return h && h.length ? h : undefined;
  });
  return (hovers ?? [])
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === "string" ? c : c.value))
    .join("\n");
}

suite("m1-vscode multi-root workspace", () => {
  suiteSetup(async function () {
    this.timeout(60000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} should be present`);
    await ext.activate();
  });

  test("workspace has two folders", () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    assert.strictEqual(folders.length, 2, "expected a 2-folder workspace");
  });

  test("hover works on a file in project A", async function () {
    this.timeout(60000);
    const text = await hoverText(
      path.resolve(__dirname, "../multiroot/a/Main.m1scr"),
    );
    assert.match(text, /alpha/, "hover should mention the A-project local");
    assert.match(text, /Integer/, "A's server should infer the local's type");
  });

  test("hover works on a file in project B (second root)", async function () {
    this.timeout(60000);
    const text = await hoverText(
      path.resolve(__dirname, "../multiroot/b/Main.m1scr"),
    );
    assert.match(text, /beta/, "hover should mention the B-project local");
    assert.match(text, /Integer/, "B's server should infer the local's type");
  });

  // Regression for the scoped-selector root-anchor bug (#20): each per-root
  // server must claim only the .m1scr files under its own root. That requires an
  // anchored relative pattern ({ baseUri, pattern }) in the document filter;
  // handing the bare `**/*.m1scr` glob string strips the anchor, so every server
  // claims every .m1scr (duplicate diagnostics/hover, ambiguous
  // go-to-def/rename). The hover tests above still pass with the over-broad
  // selector, so assert the selector shape directly — deterministic, no
  // dependence on result-merging.
  test("each scoped client is anchored to its own root", async function () {
    this.timeout(60000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} should be present`);
    const api = ext.exports;
    assert.ok(
      api && typeof api.scopedClientInfo === "function",
      "extension API should expose scopedClientInfo()",
    );

    const folders = vscode.workspace.workspaceFolders ?? [];
    const expectedRoots = folders.map((f) => f.uri.fsPath).sort();

    // The scoped clients are started asynchronously during/after activation;
    // wait until one exists per project root.
    const info = await retry(async () => {
      const snap = api.scopedClientInfo();
      return snap.length === expectedRoots.length ? snap : undefined;
    });
    assert.ok(
      info,
      `expected ${expectedRoots.length} scoped clients, one per root`,
    );

    assert.strictEqual(
      info.length,
      expectedRoots.length,
      "one scoped client per project root",
    );

    const actualRoots = info.map((c) => c.root).sort();
    assert.deepStrictEqual(
      actualRoots,
      expectedRoots,
      "scoped clients should cover exactly the workspace project roots",
    );

    for (const c of info) {
      assert.ok(
        c.patternIsRelative,
        `client for ${c.root} must use a RelativePattern (anchored), not a bare glob string`,
      );
      assert.strictEqual(
        c.patternBase,
        c.root,
        `client for ${c.root} must be anchored to its own root (baseUri == root)`,
      );
    }
  });
});
