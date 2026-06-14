// Unit test: the m1-project validate DiagnosticCollection is owned by the
// extension lifecycle (disposed on deactivate / extension-host reload).
//
// validateProject() loads `m1-project validate` findings into a
// DiagnosticCollection. Every other disposable in the extension (output
// channel, status bar, tree view, commands, watchers) is pushed onto
// context.subscriptions so it is disposed when the extension deactivates.
// The validate collection must be too — otherwise it (and its diagnostics)
// outlive the extension on deactivate and can survive an extension-host
// reload in the same session, leaking the collection and leaving stale
// Problems-panel entries.
//
// This test bundles the real src/project-commands.ts (via esbuild, with a
// vscode shim) and asserts that initProjectCommands(context) registers the
// "m1-project" DiagnosticCollection on context.subscriptions, and that
// validateProject() populates *that same* collection rather than lazily
// creating an unregistered one.
//
// Does NOT need a live VS Code Extension Host.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);

// ---------------------------------------------------------------------------
// Scratch workspace: a fake project dir + a fake m1-project binary.
// ---------------------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), "m1-validate-disp-"));
const projectDir = path.join(work, "proj");
fs.mkdirSync(projectDir);
const projectFile = path.join(projectDir, "Project.m1prj");
fs.writeFileSync(projectFile, "<MTC/>");

// Fake m1-project: `validate` prints one WARN finding so set() runs.
const fakeBin = path.join(
  work,
  process.platform === "win32" ? "m1-project.exe" : "m1-project",
);
const fakeScript = `#!/usr/bin/env node
process.stdout.write("WARN Root.Engine.Speed: example finding\\n1 finding\\n");
`;
fs.writeFileSync(fakeBin, fakeScript);
fs.chmodSync(fakeBin, 0o755);

// ---------------------------------------------------------------------------
// VS Code shim — tracks every DiagnosticCollection created and disposed so we
// can prove the validate collection is owned by context.subscriptions.
// ---------------------------------------------------------------------------
const createdCollections = [];

function makeDiagnosticCollection(name) {
  const coll = {
    name,
    disposed: false,
    entries: new Map(),
    set(uri, diags) {
      this.entries.set(uri?.fsPath ?? String(uri), diags);
    },
    delete(uri) {
      this.entries.delete(uri?.fsPath ?? String(uri));
    },
    clear() {
      this.entries.clear();
    },
    dispose() {
      this.disposed = true;
    },
  };
  createdCollections.push(coll);
  return coll;
}

const vscodeShim = {
  window: {
    activeTextEditor: {
      document: {
        uri: { scheme: "file", fsPath: path.join(projectDir, "Some.m1scr") },
      },
    },
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    createOutputChannel: () => ({
      appendLine() {},
      append() {},
      show() {},
      dispose() {},
    }),
  },
  workspace: {
    workspaceFolders: [
      { uri: { fsPath: projectDir, scheme: "file" }, name: "proj", index: 0 },
    ],
    getConfiguration: (section) => ({
      get: (key) =>
        section === "m1" && key === "project.path" ? fakeBin : undefined,
    }),
    findFiles: () => Promise.resolve([]),
  },
  languages: {
    createDiagnosticCollection: makeDiagnosticCollection,
  },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: "file" }),
  },
  Range: class {
    constructor(a, b, c, d) {
      Object.assign(this, { a, b, c, d });
    }
  },
  Diagnostic: class {
    constructor(range, message, severity) {
      Object.assign(this, { range, message, severity });
    }
  },
  DiagnosticSeverity: { Error: 0, Warning: 1 },
};

// vscode-languageclient/node: only FileChangeType is referenced at module load.
const lspNodeShim = { FileChangeType: { Changed: 2, Created: 1, Deleted: 3 } };

// ---------------------------------------------------------------------------
// Bundle src/project-commands.ts to CJS with the shims aliased in.
// ---------------------------------------------------------------------------
const shimDir = path.join(work, "shims");
fs.mkdirSync(shimDir);
fs.writeFileSync(
  path.join(shimDir, "vscode.cjs"),
  "module.exports = globalThis.__vscodeShim;\n",
);
fs.writeFileSync(
  path.join(shimDir, "lsp-node.cjs"),
  "module.exports = globalThis.__lspNodeShim;\n",
);

globalThis.__vscodeShim = vscodeShim;
globalThis.__lspNodeShim = lspNodeShim;

const outFile = path.join(work, "project-commands.cjs");
await build({
  entryPoints: [path.join(repo, "src", "project-commands.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
  alias: {
    vscode: path.join(shimDir, "vscode.cjs"),
    "vscode-languageclient/node": path.join(shimDir, "lsp-node.cjs"),
  },
});

const mod = await import(pathToFileURL(outFile).href);

const context = {
  asAbsolutePath: (rel) => path.join(work, "ext", rel),
  subscriptions: [],
};

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

// initProjectCommands is the activation hook (called from activate() with the
// ExtensionContext in scope). It must register the validate collection so the
// extension owns its lifetime.
mod.initProjectCommands(vscodeShim.window.createOutputChannel(), context);

const registered = context.subscriptions.filter(
  (d) => d && typeof d.dispose === "function" && d.name === "m1-project",
);
check(
  registered.length === 1,
  `the m1-project DiagnosticCollection is pushed onto context.subscriptions (found ${registered.length})`,
);

// Run validateProject and confirm it populates the *registered* collection,
// not a fresh unregistered one.
await mod.validateProject(context);

check(
  createdCollections.length === 1,
  `exactly one DiagnosticCollection is ever created (no lazy duplicate) — found ${createdCollections.length}`,
);
const owned = registered[0];
check(
  !!owned && owned.entries.size === 1,
  "validateProject set findings on the extension-owned collection",
);

// Simulate deactivate: disposing context.subscriptions must dispose the
// validate collection too (no leak across extension-host reload).
for (const d of context.subscriptions) d.dispose?.();
check(
  !!owned && owned.disposed === true,
  "disposing context.subscriptions disposes the validate collection",
);

// ---------------------------------------------------------------------------
fs.rmSync(work, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nvalidate-diagnostics-dispose: all checks passed");
