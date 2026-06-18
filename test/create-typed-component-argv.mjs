// Unit test: createChannel / createParameter assemble the exact m1-project argv.
//
// Both commands share one flow (createTypedComponent): a Root.* name input box,
// an optional storage-type QuickPick, an optional unit input box, and an optional
// security QuickPick, then conditional argv assembly — --type / --unit / --security
// are pushed ONLY when the user picked a real value (not "(none)" / blank).
//
// They differ only in the verb (create-channel vs create-parameter) and a few
// labels. Because the two used to be ~50-line copy-paste twins with no test on the
// argv, a validation tweak or flag change could silently drift between them.
//
// This test bundles the real src/project-commands.ts (esbuild + a vscode shim) and
// drives BOTH commands against a fake m1-project that records its argv. It asserts:
//   1. The "all fields set" run produces the full, correctly-ordered argv for each
//      verb (--type/--unit/--security all present).
//   2. The "all optional fields skipped" run pushes name only — no --type/--unit/
//      --security — for each verb.
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), "m1-createtyped-"));
const projectDir = path.join(work, "proj");
fs.mkdirSync(projectDir);
const projectFile = path.join(projectDir, "Project.m1prj");
fs.writeFileSync(projectFile, "<MTC/>");

const argvLog = path.join(work, "argv.log");

// Fake m1-project: append our argv (one JSON line) to the log. The flows under
// test only consume stdout for list-security; emit an empty security list so the
// security QuickPick offers just "(none)" — our script picks a level regardless.
const fakeBin = path.join(
  work,
  process.platform === "win32" ? "m1-project.exe" : "m1-project",
);
const fakeScript = `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("[]");
`;
fs.writeFileSync(fakeBin, fakeScript);
fs.chmodSync(fakeBin, 0o755);

// ---------------------------------------------------------------------------
// Scriptable VS Code shim. `answers` is mutated per scenario below.
// ---------------------------------------------------------------------------
const answers = {
  name: undefined,
  type: undefined, // QuickPick: a storage type, or "(none)"
  unit: undefined, // InputBox: a unit string, or ""
  security: undefined, // QuickPick: a level, or "(none)"
};

function scriptedInputBox(opts) {
  const title = opts?.title ?? "";
  const prompt = opts?.prompt ?? "";
  if (/^Create M1 (Channel|Parameter)$/.test(title)) {
    return Promise.resolve(answers.name);
  }
  if (/unit/i.test(title) || /unit/i.test(prompt)) {
    return Promise.resolve(answers.unit);
  }
  return Promise.resolve("");
}

function scriptedQuickPick(items, opts) {
  const title = opts?.title ?? "";
  if (/storage type/i.test(title)) return Promise.resolve(answers.type);
  if (/security/i.test(title)) return Promise.resolve(answers.security);
  return Promise.resolve(items[0]);
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
  languages: {
    createDiagnosticCollection: (name) => ({
      name,
      set() {},
      delete() {},
      clear() {},
      dispose() {},
    }),
  },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: "file" }),
  },
};

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

// Pin the project binary via m1.project.path.
vscodeShim.workspace.getConfiguration = (section) => ({
  get: (key) =>
    section === "m1" && key === "project.path" ? fakeBin : undefined,
});

const context = {
  asAbsolutePath: (rel) => path.join(work, "ext", rel),
  subscriptions: [],
};

mod.initProjectCommands(vscodeShim.window.createOutputChannel(), context);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let failures = 0;
function check(ok, label) {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    console.error(`  FAIL  ${label}`);
    failures++;
  }
}

// Run a create command and return the create-* argv it issued.
async function runAndCapture(fn, verb) {
  fs.writeFileSync(argvLog, "");
  await fn(context);
  return fs
    .readFileSync(argvLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((a) => a[0] === verb);
}

const cases = [
  { fn: mod.createChannel, verb: "create-channel", noun: "channel" },
  { fn: mod.createParameter, verb: "create-parameter", noun: "parameter" },
];

// ---------------------------------------------------------------------------
// Scenario A: every optional field set → full argv, in order.
// ---------------------------------------------------------------------------
for (const { fn, verb, noun } of cases) {
  answers.name = "Root.Engine.New";
  answers.type = "signed 16-bit";
  answers.unit = "rpm";
  answers.security = "Calibration";

  const argv = await runAndCapture(fn, verb);
  const expected = [
    verb,
    "--project",
    projectFile,
    "--name",
    "Root.Engine.New",
    "--type",
    "signed 16-bit",
    "--unit",
    "rpm",
    "--security",
    "Calibration",
  ];
  check(
    JSON.stringify(argv) === JSON.stringify(expected),
    `${noun}: all fields set → ${JSON.stringify(expected)} (got ${JSON.stringify(argv)})`,
  );
}

// ---------------------------------------------------------------------------
// Scenario B: optional fields skipped → name only, no --type/--unit/--security.
// ---------------------------------------------------------------------------
for (const { fn, verb, noun } of cases) {
  answers.name = "  Root.Engine.Bare  "; // also exercise the .trim()
  answers.type = "(none)";
  answers.unit = "   "; // whitespace → no --unit
  answers.security = "(none)";

  const argv = await runAndCapture(fn, verb);
  const expected = [
    verb,
    "--project",
    projectFile,
    "--name",
    "Root.Engine.Bare",
  ];
  check(
    JSON.stringify(argv) === JSON.stringify(expected),
    `${noun}: optional fields skipped → name only (got ${JSON.stringify(argv)})`,
  );
}

// ---------------------------------------------------------------------------
fs.rmSync(work, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\ncreate-typed-component-argv: all checks passed");
