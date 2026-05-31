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

suite("m1-vscode in a real VS Code Extension Host", () => {
  let doc;

  suiteSetup(async function () {
    this.timeout(60000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} should be present`);
    await ext.activate();
    const file = path.resolve(__dirname, "../fixtures/sample.m1scr");
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
  });

  test("extension is active", () => {
    assert.strictEqual(vscode.extensions.getExtension(EXT_ID).isActive, true);
  });

  test(".m1scr is recognised as the m1scr language", () => {
    assert.strictEqual(doc.languageId, "m1scr");
  });

  test("hover (LSP) returns the inferred type for a local", async function () {
    this.timeout(60000);
    // 'count' in: local count = 0;
    const line = doc
      .getText()
      .split("\n")
      .findIndex((l) => l.includes("local count"));
    const ch = doc.lineAt(line).text.indexOf("count");
    const pos = new vscode.Position(line, ch);

    const hovers = await retry(async () => {
      const h = await vscode.commands.executeCommand(
        "vscode.executeHoverProvider",
        doc.uri,
        pos,
      );
      return h && h.length ? h : null;
    });
    assert.ok(
      hovers && hovers.length,
      "expected a hover from the language server",
    );
    const text = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === "string" ? c : c.value))
      .join("\n");
    console.log("    hover text:", JSON.stringify(text));
    assert.match(text, /count/, "hover should mention the symbol");
    assert.match(
      text,
      /Integer/,
      "hover should infer Integer (server type inference)",
    );
  });

  test("formatting (LSP) reformats the document", async function () {
    this.timeout(60000);
    const edits = await retry(async () => {
      const e = await vscode.commands.executeCommand(
        "vscode.executeFormatDocumentProvider",
        doc.uri,
        { tabSize: 4, insertSpaces: true },
      );
      return e && e.length ? e : null;
    });
    assert.ok(
      Array.isArray(edits) && edits.length > 0,
      "expected format edits for the mis-spaced line",
    );
    console.log(`    format produced ${edits.length} edit(s)`);
  });

  test("diagnostics channel is wired (array, no throw)", () => {
    const diags = vscode.languages.getDiagnostics(doc.uri);
    assert.ok(Array.isArray(diags), "diagnostics should be an array");
    console.log(`    diagnostics on sample: ${diags.length}`);
  });
});
