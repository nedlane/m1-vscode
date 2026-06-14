// Unit test: pickChannel must reuse the shared list-components data path.
//
// project-commands.ts exposes listComponents() (the documented single data
// source for the project tree + security matrix) which runs
//   m1-project list-components --project <file> --json
// and parses the result into typed ComponentEntry[].
//
// pickChannel (used by createTable for axis sources) previously RE-IMPLEMENTED
// that flow inline: a divergent arg order (--json --project) and an ad-hoc
// { path; classname }[] shadow type. That duplicated CLI invocation drifts.
//
// This test bundles the real src/project-commands.ts (via esbuild, with a vscode
// shim) and drives BOTH code paths against a fake m1-project binary that records
// its argv. It asserts:
//   1. listComponents and pickChannel issue the EXACT SAME list-components argv
//      (same flags, same order) — i.e. one shared invocation, no drift.
//   2. pickChannel surfaces only BuiltIn.Channel components as axis sources.
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), "m1-pickchan-"));
const projectDir = path.join(work, "proj");
fs.mkdirSync(projectDir);
const projectFile = path.join(projectDir, "Project.m1prj");
fs.writeFileSync(projectFile, "<MTC/>");

const argvLog = path.join(work, "argv.log");

// The component payload the fake CLI emits — a mix so the channel filter matters.
const components = [
  {
    path: "Root.Engine.Speed",
    classname: "BuiltIn.Channel",
    type: null,
    unit: null,
    security: null,
    call_rate: null,
  },
  {
    path: "Root.Engine.Load",
    classname: "BuiltIn.Channel",
    type: null,
    unit: null,
    security: null,
    call_rate: null,
  },
  {
    path: "Root.Calibration.Map",
    classname: "BuiltIn.Table",
    type: null,
    unit: null,
    security: null,
    call_rate: null,
  },
  {
    path: "Root.Limits.Max",
    classname: "BuiltIn.Constant",
    type: null,
    unit: null,
    security: null,
    call_rate: null,
  },
];

// Fake m1-project: append our argv (one JSON line) to the log, print the payload.
const fakeBin = path.join(
  work,
  process.platform === "win32" ? "m1-project.exe" : "m1-project",
);
const fakeScript = `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(${JSON.stringify(JSON.stringify(components))});
`;
fs.writeFileSync(fakeBin, fakeScript);
fs.chmodSync(fakeBin, 0o755);

// ---------------------------------------------------------------------------
// VS Code shim — covers every symbol project-commands.ts touches at runtime
// for these two code paths. UI prompts are scripted to drive createTable.
// ---------------------------------------------------------------------------
let channelPickItems = []; // captures the items shown for axis-source pickers

// Scripted answers, consumed in order, for createTable's prompts.
function scriptedInputBox(opts) {
  // Table name (validated against /^Root\..+/), then axis-site numbers.
  const title = opts?.title ?? "";
  if (/Table/i.test(title)) return Promise.resolve("Root.Engine.New Map");
  return Promise.resolve(""); // skip optional site counts
}

function scriptedQuickPick(items, opts) {
  const title = opts?.title ?? "";
  if (/axis source/i.test(title)) {
    channelPickItems.push(items.slice());
    // Pick the first concrete channel for X; skip Y (so we stop after one extra).
    if (/X-axis/i.test(title)) return Promise.resolve(items[0]);
    return Promise.resolve(
      items.find((i) => String(i).startsWith("(none")) ?? items[0],
    );
  }
  // Security level prompt → (none).
  return Promise.resolve("(none)");
}

const messages = { info: [], warn: [], error: [] };

const vscodeShim = {
  window: {
    activeTextEditor: {
      document: {
        uri: { scheme: "file", fsPath: path.join(projectDir, "Some.m1scr") },
      },
    },
    showInputBox: scriptedInputBox,
    showQuickPick: scriptedQuickPick,
    showInformationMessage: (m) => {
      messages.info.push(m);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (m) => {
      messages.warn.push(m);
      return Promise.resolve(undefined);
    },
    showErrorMessage: (m) => {
      messages.error.push(m);
      return Promise.resolve(undefined);
    },
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
    getConfiguration: () => ({ get: () => undefined }),
    findFiles: () => Promise.resolve([]),
  },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: "file" }),
  },
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

// Minimal ExtensionContext: pin the project binary via m1.project.path.
// resolveBin reads m1.project.path from getConfiguration("m1"); override it.
vscodeShim.workspace.getConfiguration = (section) => ({
  get: (key) =>
    section === "m1" && key === "project.path" ? fakeBin : undefined,
});

const context = {
  asAbsolutePath: (rel) => path.join(work, "ext", rel),
  subscriptions: [],
};

// project-commands wires its output channel via initProjectCommands.
mod.initProjectCommands(vscodeShim.window.createOutputChannel());

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

// --- 1. listComponents issues its documented argv ---
fs.writeFileSync(argvLog, "");
const lc = await mod.listComponents(context);
check(
  !!lc && lc.components.length === components.length,
  "listComponents returns the full ComponentEntry[]",
);
const listComponentsArgv = fs
  .readFileSync(argvLog, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .find((a) => a[0] === "list-components");
check(
  JSON.stringify(listComponentsArgv) ===
    JSON.stringify(["list-components", "--project", projectFile, "--json"]),
  `listComponents argv is [list-components --project <file> --json] (got ${JSON.stringify(listComponentsArgv)})`,
);

// --- 2. pickChannel (via createTable) issues the SAME list-components argv ---
fs.writeFileSync(argvLog, "");
channelPickItems = [];
await mod.createTable(context);

const lines = fs
  .readFileSync(argvLog, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const pickChannelArgvs = lines.filter((a) => a[0] === "list-components");
check(
  pickChannelArgvs.length > 0,
  "createTable invoked list-components for axis sources",
);
for (const argv of pickChannelArgvs) {
  check(
    JSON.stringify(argv) === JSON.stringify(listComponentsArgv),
    `pickChannel list-components argv matches listComponents (got ${JSON.stringify(argv)})`,
  );
}

// --- 3. Only BuiltIn.Channel components are offered as axis sources ---
check(channelPickItems.length > 0, "an axis-source QuickPick was shown");
const flatItems = channelPickItems
  .flat()
  .filter((i) => !String(i).startsWith("(none"));
check(
  flatItems.length > 0 &&
    flatItems.every(
      (p) => p === "Root.Engine.Speed" || p === "Root.Engine.Load",
    ),
  `axis sources are exactly the BuiltIn.Channel paths (got ${JSON.stringify([...new Set(flatItems)])})`,
);
check(
  !flatItems.includes("Root.Calibration.Map") &&
    !flatItems.includes("Root.Limits.Max"),
  "non-channel components (Table/Constant) are excluded from axis sources",
);

// ---------------------------------------------------------------------------
fs.rmSync(work, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\npick-channel-reuse: all checks passed");
