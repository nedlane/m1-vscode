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

  // M1 channels routinely contain spaces (e.g. `Rear Left Torque`). The
  // contributed wordPattern (language-configuration.json) must make VS Code
  // treat the whole multi-word name as one word, so double-click selection and
  // Ctrl+Left/Right word motions don't stop mid-name. getWordRangeAtPosition is
  // exactly the engine path both of those use, applied through the real,
  // VS Code-compiled wordPattern (not a JS approximation).
  test("wordPattern selects a full space-containing channel name", async () => {
    const md = await vscode.workspace.openTextDocument({
      language: "m1scr",
      content: "Rear Left Torque = Driver Throttle * 100.0;\n",
    });
    const wordOf = (col) => {
      const r = md.getWordRangeAtPosition(new vscode.Position(0, col));
      return r ? md.getText(r) : undefined;
    };
    // Cursor on each of the three sub-words selects the whole channel.
    for (const probe of ["Rear", "Left", "Torque"]) {
      const col = md.getText().indexOf(probe);
      assert.strictEqual(
        wordOf(col),
        "Rear Left Torque",
        `cursor on "${probe}" should select the whole channel "Rear Left Torque"`,
      );
    }
    // The right-hand channel selects on its own (not across the `=`).
    assert.strictEqual(
      wordOf(md.getText().indexOf("Throttle")),
      "Driver Throttle",
      'cursor on "Throttle" should select "Driver Throttle"',
    );
  });

  // #175: the clickable execution-rate code lens fires the client-registered
  // `m1.revealLocation` command (NOT a server executeCommandProvider command),
  // so it must be present in the command registry.
  test("m1.revealLocation command is registered", async () => {
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(
      cmds.includes("m1.revealLocation"),
      "m1.revealLocation should be registered client-side",
    );
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

  // Regression: go-to-definition needs the m1-lsp server rooted at the
  // Project.m1prj dir. The fixtures workspace opens `fixtures/`, but the project
  // is nested at `fixtures/proj/`. m1-lsp's `find_m1prj` only walks *ancestors*,
  // so unless the extension discovers and roots at the nested project, the server
  // loads no project and `goto_definition` returns null (exactly the user's bug).
  test("go-to-definition resolves a user function to its .m1scr file", async function () {
    this.timeout(60000);
    const callerPath = path.resolve(__dirname, "../fixtures/proj/Caller.m1scr");
    const caller = await vscode.workspace.openTextDocument(callerPath);
    await vscode.window.showTextDocument(caller);
    // Cursor on the `Do Thing()` call (line 1, col 0).
    const line = caller
      .getText()
      .split("\n")
      .findIndex((l) => l.includes("Do Thing("));
    const pos = new vscode.Position(line, 0);

    const locs = await retry(async () => {
      const l = await vscode.commands.executeCommand(
        "vscode.executeDefinitionProvider",
        caller.uri,
        pos,
      );
      return l && l.length ? l : null;
    });
    assert.ok(
      locs && locs.length,
      "expected a definition Location from the server (project must be loaded)",
    );
    const targets = locs.map((l) => (l.targetUri || l.uri).fsPath);
    console.log("    definition targets:", JSON.stringify(targets));
    assert.ok(
      targets.some((t) => t.endsWith("Do Thing.m1scr")),
      "go-to-definition should jump to the user function's backing file",
    );
  });

  // The m1-project-backed editing commands (#85/#86). Drives the real command
  // end-to-end: stub the prompts, point at a throwaway project, run the command,
  // and assert m1-project actually rewrote Project.m1prj.
  test("m1.createChannel edits Project.m1prj via m1-project", async function () {
    this.timeout(60000);
    const os = require("os");
    const fs = require("fs");

    // A bundled (or PATH) m1-project binary is required; skip cleanly if absent.
    const bundled = path.resolve(__dirname, "../../../server/m1-project");
    const bin = fs.existsSync(bundled) ? bundled : undefined;
    if (!bin) {
      console.log("    m1-project binary absent; skipping create-channel E2E");
      return;
    }
    await vscode.workspace
      .getConfiguration("m1")
      .update("project.path", bin, vscode.ConfigurationTarget.Global);

    // Throwaway project: a group to hang the new channel off, plus a script to
    // make the dir the active project root.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1proj-"));
    fs.writeFileSync(
      path.join(dir, "Project.m1prj"),
      '<?xml version="1.0"?>\n<Project>\n  <Component Classname="BuiltIn.GroupCompound" Name="Root"/>\n  <Component Classname="BuiltIn.GroupCompound" Name="Root.Engine"/>\n</Project>\n',
    );
    fs.writeFileSync(path.join(dir, "Main.m1scr"), "local x = 0;\n");
    const main = await vscode.workspace.openTextDocument(
      path.join(dir, "Main.m1scr"),
    );
    await vscode.window.showTextDocument(main);

    // Stub the interactive prompts the command issues, in order.
    const inputs = ["Root.Engine.NewSignal", ""]; // name, then unit
    const picks = ["f32", "Tune"]; // type, then security
    const origInput = vscode.window.showInputBox;
    const origPick = vscode.window.showQuickPick;
    vscode.window.showInputBox = async () => inputs.shift();
    vscode.window.showQuickPick = async () => picks.shift();
    try {
      await vscode.commands.executeCommand("m1.createChannel");
    } finally {
      vscode.window.showInputBox = origInput;
      vscode.window.showQuickPick = origPick;
    }

    const written = fs.readFileSync(path.join(dir, "Project.m1prj"), "utf8");
    assert.match(
      written,
      /Name="Root\.Engine\.NewSignal"/,
      "m1-project should have inserted the new channel component",
    );
    assert.match(written, /Type="f32"/, "the channel should carry its type");
  });
});
