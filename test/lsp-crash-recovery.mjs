import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "m1-crash-recovery-"));
const roots = [path.join(work, "a"), path.join(work, "b")];
const notifications = [];
const commands = [];
const created = [];
const uri = (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` });
const output = () => ({ appendLine() {}, dispose() {}, show() {} });
const State = { Running: 2, Stopped: 1 };
const CloseAction = { DoNotRestart: 1, Restart: 2 };
const ErrorAction = { Continue: 1, Shutdown: 2 };

class LanguageClient {
  constructor(_id, _name, _server, options) {
    this.options = options;
    this.stops = 0;
    this.listeners = [];
    created.push(this);
  }
  registerFeature() {}
  onDidChangeState(listener) {
    this.listeners.push(listener);
  }
  async start() {
    this.listeners.forEach((f) => f({ newState: State.Running }));
  }
  async stop() {
    this.stops++;
    this.listeners.forEach((f) => f({ newState: State.Stopped }));
  }
  async setTrace() {}
  async crash() {
    const closed = await this.options.errorHandler.closed();
    assert.equal(closed.action, CloseAction.DoNotRestart);
    if (!closed.handled) notifications.push("default close notification");
    this.listeners.forEach((f) => f({ newState: State.Stopped }));
  }
}

const vscode = {
  Uri: { file: uri },
  RelativePattern: class {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  workspace: {
    workspaceFolders: [],
    findFiles: async () =>
      roots.map((root) => uri(path.join(root, "Project.m1prj"))),
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    createFileSystemWatcher: () => ({
      disposed: false,
      dispose() {
        this.disposed = true;
      },
    }),
  },
  window: {
    createOutputChannel: output,
    showErrorMessage: async (message) => {
      notifications.push(message);
      return "Restart";
    },
  },
  commands: {
    executeCommand: async (command) => commands.push(command),
  },
};

try {
  globalThis.__m1CrashReview = {
    vscode,
    languageclient: {
      LanguageClient,
      State,
      CloseAction,
      ErrorAction,
      Trace: { fromString: (value) => value },
      TransportKind: { stdio: 0 },
    },
  };
  const shims = {};
  for (const name of ["vscode", "languageclient"]) {
    shims[name] = path.join(work, `${name}.cjs`);
    fs.writeFileSync(
      shims[name],
      `module.exports = globalThis.__m1CrashReview.${name};\n`,
    );
  }
  const bundled = path.join(work, "lsp-client.cjs");
  await build({
    entryPoints: [path.join(repo, "src/lsp-client.ts")],
    outfile: bundled,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    alias: {
      vscode: shims.vscode,
      "vscode-languageclient/node": shims.languageclient,
    },
  });
  const lsp = createRequire(import.meta.url)(bundled);
  const context = {
    subscriptions: [],
    asAbsolutePath: () => bundled,
  };
  lsp.initLspClient(output(), () => ({}));
  await lsp.syncClients(context);
  assert.equal(created.length, 2);
  const crashed = lsp.clients.get(roots[0]);
  const healthy = lsp.clients.get(roots[1]);
  assert.equal(
    crashed.client.options.errorHandler.error(
      new Error("transport"),
      undefined,
      1,
    ).action,
    ErrorAction.Continue,
  );
  assert.equal(
    crashed.client.options.errorHandler.error(
      new Error("transport"),
      undefined,
      4,
    ).action,
    ErrorAction.Shutdown,
  );
  await crashed.client.crash();
  for (let i = 0; i < 20 && created.length < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(
    notifications.length,
    1,
    "one crash must produce one notification",
  );
  assert.match(notifications[0], /stopped unexpectedly/);
  assert.equal(created.length, 3, "the missing project server is restarted");
  assert.notEqual(lsp.clients.get(roots[0]).client, crashed.client);
  assert.equal(lsp.clients.get(roots[1]).client, healthy.client);
  assert.equal(healthy.client.stops, 0, "healthy project server keeps running");
  assert.ok(crashed.watchers.every((watcher) => watcher.disposed));
  assert.ok(healthy.watchers.every((watcher) => !watcher.disposed));
  assert.deepEqual(
    commands,
    [],
    "crash recovery must not invoke a global restart",
  );
  await lsp.stopAllClients();
  assert.equal(
    notifications.length,
    1,
    "intentional stops do not report crashes",
  );
  console.log(
    "LSP crash recovery: one notification and only the failed root restarts",
  );
} finally {
  delete globalThis.__m1CrashReview;
  fs.rmSync(work, { recursive: true, force: true });
}
