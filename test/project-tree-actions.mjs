// Unit test: every projectTree context-menu node action is wired correctly.
//
// registerProjectTree (src/project-tree.ts) registers a row of context-menu
// commands of the identical shape:
//   vscode.commands.registerCommand("m1.projectTree.X", async (node) => {
//     await commands.Y(context, node?.path);
//     provider.refresh();
//   });
// Each entry only varies in the command id and which commands.* function it
// calls. That ~15-entry block is pure boilerplate; a copy-paste slip (wrong
// function, or a missing provider.refresh()) is easy to miss in review.
//
// This test bundles the real src/project-tree.ts (via esbuild, with a vscode
// shim) and drives the registrations end-to-end. For each expected node
// action it asserts:
//   1. the command id is registered,
//   2. invoking it calls EXACTLY its matching commands.* function (no other),
//      forwarding the node's path as the selection,
//   3. invoking it triggers a tree refresh (onDidChangeTreeData fires).
//
// This guards the table-driven registration against per-entry drift without
// pinning the implementation to a particular source structure.
//
// Does NOT need a live VS Code Extension Host.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "m1-tree-actions-"));

// ---------------------------------------------------------------------------
// VS Code shim — records registered commands and tree-data-change fires.
// ---------------------------------------------------------------------------
const registered = new Map(); // id -> handler
let refreshCount = 0;

class EventEmitter {
  constructor() {
    this.event = () => ({ dispose() {} });
  }
  fire() {
    refreshCount++;
  }
}

const vscodeShim = {
  EventEmitter,
  TreeItem: class {
    constructor(label, state) {
      this.label = label;
      this.collapsibleState = state;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  window: {
    registerTreeDataProvider: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: (id, handler) => {
      registered.set(id, handler);
      return { dispose() {} };
    },
  },
};

const shimDir = path.join(work, "shims");
fs.mkdirSync(shimDir);
fs.writeFileSync(
  path.join(shimDir, "vscode.cjs"),
  "module.exports = globalThis.__vscodeShim;\n",
);
fs.writeFileSync(
  path.join(shimDir, "project-commands.cjs"),
  // project-tree.ts imports { ComponentEntry, listComponents } at module load;
  // only listComponents is referenced at runtime, and not on these code paths.
  "module.exports = { listComponents: async () => undefined };\n",
);

globalThis.__vscodeShim = vscodeShim;

const outFile = path.join(work, "project-tree.cjs");
await build({
  entryPoints: [path.join(repo, "src", "project-tree.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
  alias: {
    vscode: path.join(shimDir, "vscode.cjs"),
  },
  plugins: [
    {
      name: "stub-project-commands",
      setup(b) {
        // project-tree.ts imports { ComponentEntry, listComponents } from
        // "./project-commands"; stub it so we drive the tree in isolation.
        b.onResolve({ filter: /project-commands$/ }, () => ({
          path: path.join(shimDir, "project-commands.cjs"),
        }));
      },
    },
  ],
});

const mod = await import(pathToFileURL(outFile).href);

// ---------------------------------------------------------------------------
// Build a `commands` object whose every function records that it was called
// (with which selection), so we can prove each registration calls the right
// one and forwards node.path.
// ---------------------------------------------------------------------------
const calls = []; // { fn, sel }
function spy(fn) {
  return async (_ctx, sel) => {
    calls.push({ fn, sel });
  };
}

// Map: command id -> the commands.* function name it MUST call.
const expected = {
  "m1.projectTree.setType": "setType",
  "m1.projectTree.setUnit": "setUnit",
  "m1.projectTree.setValidation": "setValidation",
  "m1.projectTree.setQuantity": "setQuantity",
  "m1.projectTree.setFormat": "setFormat",
  "m1.projectTree.setDps": "setDps",
  "m1.projectTree.setDisplayRange": "setDisplayRange",
  "m1.projectTree.addTag": "addTag",
  "m1.projectTree.removeTag": "removeTag",
  "m1.projectTree.setSecurity": "setSecurity",
  "m1.projectTree.createGroup": "createGroup",
  "m1.projectTree.createConstant": "createConstant",
  "m1.projectTree.createTable": "createTable",
  "m1.projectTree.rename": "renameComponent",
  "m1.projectTree.delete": "deleteComponent",
};

const fnNames = [...new Set(Object.values(expected))];
const commands = {};
for (const name of fnNames) commands[name] = spy(name);

const context = { subscriptions: [] };

mod.registerProjectTree(context, commands);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
let failures = 0;
function check(ok, label) {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    console.error(`  FAIL  ${label}`);
    failures++;
  }
}

// The explicit (non-table) refresh command must still exist with no node arg.
check(
  registered.has("m1.projectTree.refresh"),
  "m1.projectTree.refresh is registered",
);

// Each disposable returned must be pushed onto context.subscriptions so the
// extension lifecycle owns it.
check(
  context.subscriptions.length >= Object.keys(expected).length + 1,
  "every registered command + the refresh command is pushed onto subscriptions",
);

for (const [id, fnName] of Object.entries(expected)) {
  const handler = registered.get(id);
  if (!handler) {
    check(false, `${id} is registered`);
    continue;
  }
  calls.length = 0;
  const before = refreshCount;
  const node = { path: `Root.Some.${fnName}` };
  await handler(node);

  check(
    calls.length === 1 && calls[0].fn === fnName,
    `${id} calls exactly commands.${fnName} (got ${JSON.stringify(calls.map((c) => c.fn))})`,
  );
  check(
    calls.length === 1 && calls[0].sel === node.path,
    `${id} forwards node.path as the selection`,
  );
  check(refreshCount === before + 1, `${id} refreshes the tree once`);
}

// A node action invoked with no node (command palette) must not throw and must
// forward undefined as the selection.
{
  calls.length = 0;
  const handler = registered.get("m1.projectTree.setType");
  await handler(undefined);
  check(
    calls.length === 1 && calls[0].sel === undefined,
    "node action with no node forwards undefined selection (palette use)",
  );
}

// ---------------------------------------------------------------------------
fs.rmSync(work, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nproject-tree-actions: all checks passed");
