import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "m1-tree-project-"));
try {
  const uri = (file) => ({
    scheme: "file",
    fsPath: file,
    toString: () => `file://${file}`,
  });
  const project = (name) => path.join(work, name, "Project.m1prj");
  for (const name of ["a", "b"]) {
    fs.mkdirSync(path.dirname(project(name)));
    fs.writeFileSync(project(name), "fixture");
  }
  const argvLog = path.join(work, "argv.jsonl");
  const binary = path.join(work, "project-cli");
  const entries = [
    { path: "Root", classname: "BuiltIn.GroupCompound" },
    { path: "Root.Signal", classname: "BuiltIn.Channel" },
  ];
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(argvLog)},JSON.stringify(a)+'\\n');if(a[0]==='list-components')console.log(${JSON.stringify(JSON.stringify(entries))});if(a[0]==='list-security')console.log('Project level');\n`,
    { mode: 0o755 },
  );
  const commands = new Map();
  let provider,
    inputs = [],
    picks = [];
  const errors = [],
    warnings = [];
  const shim = {
    Uri: { file: uri },
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
    },
    TreeItem: class {
      constructor(label) {
        this.label = label;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    ThemeIcon: class {},
    languages: { createDiagnosticCollection: () => ({ dispose() {} }) },
    workspace: {
      workspaceFolders: ["a", "b"].map((name) => ({
        uri: uri(path.dirname(project(name))),
      })),
      getConfiguration: () => ({ get: () => binary }),
      findFiles: async () => [],
    },
    window: {
      activeTextEditor: {
        document: { uri: uri(path.join(work, "a/Main.m1scr")) },
      },
      registerTreeDataProvider: (_, p) => ((provider = p), { dispose() {} }),
      showInputBox: async () => {
        focus("b");
        return inputs.shift();
      },
      showQuickPick: async () => {
        focus("b");
        return picks.shift();
      },
      showWarningMessage: async (...args) => {
        warnings.push(args);
        focus("b");
        return "Delete";
      },
      showInformationMessage: () => {},
      showErrorMessage: (message) => errors.push(message),
    },
    commands: {
      registerCommand: (id, fn) => (commands.set(id, fn), { dispose() {} }),
    },
  };
  function focus(name) {
    shim.window.activeTextEditor.document.uri = uri(
      path.join(work, name, "Main.m1scr"),
    );
  }
  globalThis.__m1ProjectShim = shim;
  fs.writeFileSync(
    path.join(work, "vscode.cjs"),
    "module.exports=globalThis.__m1ProjectShim",
  );
  fs.writeFileSync(
    path.join(work, "clients.cjs"),
    "module.exports={clients:new Map()}",
  );
  fs.writeFileSync(
    path.join(work, "protocol.cjs"),
    "module.exports={FileChangeType:{Changed:2}}",
  );
  fs.writeFileSync(
    path.join(work, "entry.ts"),
    `export * from '${path.resolve("src/project-tree")}';export * from '${path.resolve("src/project-commands")}';`,
  );
  const bundle = path.join(work, "bundle.cjs");
  await build({
    entryPoints: [path.join(work, "entry.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    logLevel: "silent",
    alias: {
      vscode: path.join(work, "vscode.cjs"),
      "vscode-languageclient/node": path.join(work, "protocol.cjs"),
    },
    plugins: [
      {
        name: "clients",
        setup(b) {
          b.onResolve({ filter: /^\.\/lsp-client$/ }, () => ({
            path: path.join(work, "clients.cjs"),
          }));
        },
      },
    ],
  });
  const mod = require(bundle),
    context = { subscriptions: [], asAbsolutePath: (p) => path.join(work, p) };
  mod.initProjectCommands({ appendLine() {} }, context);
  mod.registerProjectTree(context, {
    ...mod,
    setType: mod.setChannelType,
    setUnit: mod.setChannelUnit,
    setSecurity: mod.setChannelSecurity,
  });
  const root = (await provider.getChildren())[0];
  const node = (await provider.getChildren(root))[0];
  assert.equal(node.path, "Root.Signal");
  const cases = [
    ["setType", [], ["u32"]],
    ["setUnit", ["rpm"], []],
    ["setSecurity", [], ["Project level"]],
    ["setValidation", [], ["None"]],
    ["setQuantity", ["Angular Speed"], []],
    ["setFormat", ["%.1f"], []],
    ["setDps", ["2"], []],
    ["setDisplayRange", ["0", "100"], []],
    ["addTag", ["Control"], []],
    ["removeTag", ["Control"], []],
    ["createGroup", ["Root.New"], []],
    ["createConstant", ["Root.New", "1"], []],
    [
      "createTable",
      ["Root.New", ""],
      ["Root.Signal", "(none)", "Project level"],
    ],
    ["rename", ["Renamed"], []],
    ["delete", [], []],
  ];
  for (const [action, typed, selected] of cases) {
    focus("b");
    inputs = [...typed];
    picks = [...selected];
    fs.writeFileSync(argvLog, "");
    await commands.get(`m1.projectTree.${action}`)(node);
    assert.deepEqual(errors, [], action);
    const calls = fs
      .readFileSync(argvLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    assert(
      calls.some((args) => !args[0].startsWith("list-")),
      `${action} performed a mutation`,
    );
    for (const args of calls)
      assert.equal(
        args[args.indexOf("--project") + 1],
        project("a"),
        `${action} keeps project identity through queries and prompts`,
      );
    assert.equal(
      inputs.length + picks.length,
      0,
      `${action} completed its prompts`,
    );
  }
  assert(
    warnings.some((args) => JSON.stringify(args).includes(project("a"))),
    "delete confirmation identifies the project",
  );
  focus("a");
  inputs = ["rpm"];
  fs.writeFileSync(argvLog, "");
  await mod.setChannelUnit(context, "Root.Signal");
  assert.equal(
    JSON.parse(fs.readFileSync(argvLog, "utf8").trim())[2],
    project("a"),
    "palette command captures project before prompt changes focus",
  );
  for (const invalid of [undefined, "", 12, "relative.m1prj"]) {
    focus("b");
    fs.writeFileSync(argvLog, "");
    await commands.get("m1.projectTree.delete")({
      path: node.path,
      projectFile: invalid,
    });
    assert.equal(
      fs.readFileSync(argvLog, "utf8"),
      "",
      "invalid node project cannot fall back",
    );
    assert.equal(errors.length, 1);
    errors.length = 0;
  }
  fs.unlinkSync(project("a"));
  fs.writeFileSync(argvLog, "");
  await commands.get("m1.projectTree.delete")(node);
  assert.equal(
    fs.readFileSync(argvLog, "utf8"),
    "",
    "missing original project cannot redirect an action",
  );
  assert.equal(errors.length, 1);
  console.log(
    "15 tree actions preserve project identity; palette and missing-project controls pass",
  );
} finally {
  delete globalThis.__m1ProjectShim;
  fs.rmSync(work, { recursive: true, force: true });
}
