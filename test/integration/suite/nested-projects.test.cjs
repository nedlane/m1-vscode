const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

async function eventually(check, message) {
  const end = Date.now() + 15000;
  let last;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message}: ${last ?? "timed out"}`);
}

suite("nested projects in a running editor", () => {
  test("marker changes transfer dirty documents and keep rename within its project", async function () {
    this.timeout(60000);
    const extension = vscode.extensions.getExtension("m1-tooling.m1-vscode");
    const api = await extension.activate();
    const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const observed = [];
    const scans = [];
    const findFiles = vscode.workspace.findFiles;
    vscode.workspace.findFiles = async (...args) => {
      const start = Date.now();
      const result = await findFiles(...args);
      scans.push({ ms: Date.now() - start, files: result.length });
      return result;
    };
    const watcher = vscode.workspace.createFileSystemWatcher("**");
    watcher.onDidCreate((uri) => observed.push(uri.fsPath));
    const root = fs.mkdtempSync(path.join(folder, "ownership-"));
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    const project = (dir) => path.join(dir, "Project.m1prj");
    const xml = (type) =>
      `<Project><Component Classname="BuiltIn.GroupCompound" Name="Root"/><Component Classname="BuiltIn.Channel" Name="Root.Signal"><Props Type="${type}"/></Component></Project>\n`;
    const source = "Signal = 1;\nlocal disk = 2;\n";
    const documents = [];
    let lastDefinition;
    try {
      fs.writeFileSync(project(root), xml("f32"));
      for (const dir of [root, nested]) {
        const file = path.join(dir, "Main.m1scr");
        fs.writeFileSync(file, source);
        documents.push(await vscode.workspace.openTextDocument(file));
      }
      const [parentDoc, childDoc] = documents;
      await vscode.window.showTextDocument(childDoc);
      const definition = async (doc) => {
        const targets = await vscode.commands.executeCommand(
          "vscode.executeDefinitionProvider",
          doc.uri,
          new vscode.Position(0, 2),
        );
        lastDefinition = {
          language: doc.languageId,
          path: doc.uri.fsPath,
          targets: targets?.map(
            (target) => (target.targetUri ?? target.uri).fsPath,
          ),
        };
        return lastDefinition.targets;
      };
      await eventually(async () => {
        const targets = await definition(childDoc);
        return targets?.length === 1 && targets[0] === project(root);
      }, "initial parent ownership");
      const edit = new vscode.WorkspaceEdit();
      edit.replace(childDoc.uri, new vscode.Range(1, 6, 1, 10), "unsavedOnly");
      assert(await vscode.workspace.applyEdit(edit));
      assert(childDoc.isDirty);
      fs.writeFileSync(project(nested), xml("u32"));
      await eventually(
        () => api.scopedClientInfo().some((client) => client.root === nested),
        "nested client appears after marker creation",
      );
      await eventually(async () => {
        const targets = await definition(childDoc);
        return targets?.length === 1 && targets[0] === project(nested);
      }, "definition uses the nearest project exactly once");
      await eventually(async () => {
        const symbols = await vscode.commands.executeCommand(
          "vscode.executeDocumentSymbolProvider",
          childDoc.uri,
        );
        return symbols?.some((symbol) => symbol.name === "unsavedOnly");
      }, "new owner receives unsaved text");
      const hovers = await vscode.commands.executeCommand(
        "vscode.executeHoverProvider",
        childDoc.uri,
        new vscode.Position(0, 2),
      );
      assert.equal(
        hovers.length,
        1,
        "one hover provider owns the nested script",
      );
      const semantic = await vscode.commands.executeCommand(
        "vscode.provideDocumentSemanticTokens",
        childDoc.uri,
      );
      assert(
        semantic?.data?.length,
        "exclusive semantic-token provider returns tokens",
      );
      const renamed = await vscode.commands.executeCommand(
        "vscode.executeDocumentRenameProvider",
        parentDoc.uri,
        new vscode.Position(0, 2),
        "ParentSignal",
      );
      const editedFiles = renamed
        .entries()
        .map(([uri]) => uri.fsPath)
        .sort();
      assert.deepEqual(
        editedFiles,
        [parentDoc.uri.fsPath, project(root)].sort(),
        "parent rename never edits the nested project's script",
      );
      const childRename = await vscode.commands.executeCommand(
        "vscode.executeDocumentRenameProvider",
        childDoc.uri,
        new vscode.Position(0, 2),
        "ChildSignal",
      );
      assert.deepEqual(
        childRename
          .entries()
          .map(([uri]) => uri.fsPath)
          .sort(),
        [childDoc.uri.fsPath, project(nested)].sort(),
      );
      fs.unlinkSync(project(nested));
      await eventually(async () => {
        const targets = await definition(childDoc);
        return (
          !api.scopedClientInfo().some((client) => client.root === nested) &&
          targets?.length === 1 &&
          targets[0] === project(root)
        );
      }, "marker removal restores parent ownership");
      const symbols = await vscode.commands.executeCommand(
        "vscode.executeDocumentSymbolProvider",
        childDoc.uri,
      );
      assert(symbols.some((symbol) => symbol.name === "unsavedOnly"));
      assert(childDoc.isDirty);
      assert.equal(
        fs.readFileSync(childDoc.uri.fsPath, "utf8"),
        source,
        "ownership transfer never saves the dirty buffer",
      );
    } finally {
      console.log("nested test observed creates", JSON.stringify(observed));
      console.log(
        "nested test clients",
        JSON.stringify(api.scopedClientInfo()),
      );
      console.log(
        "nested test last definition",
        JSON.stringify(lastDefinition),
      );
      watcher.dispose();
      vscode.workspace.findFiles = findFiles;
      console.log("project discovery measurements", JSON.stringify(scans));
      for (const document of documents) {
        await vscode.window.showTextDocument(document);
        await vscode.commands.executeCommand(
          "workbench.action.revertAndCloseActiveEditor",
        );
      }
      fs.rmSync(root, { recursive: true, force: true });
      await vscode.commands.executeCommand("m1.restartServer");
    }
  });
});
