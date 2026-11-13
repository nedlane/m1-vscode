import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "m1-routing-"));
const require = createRequire(import.meta.url);
let mod;
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let nextTimer = 10000;
const settle = async () => {
  await new Promise((resolve) => nativeSetTimeout(resolve, 40));
};
const heartbeat = async () => {
  const entries = [...timers].filter(([, timer]) => timer.delay === 1000);
  assert.equal(entries.length, 1, "one topology heartbeat scheduled");
  const [id, timer] = entries[0];
  timers.delete(id);
  timer.callback();
  await settle();
};
const context = {
  subscriptions: [],
  asAbsolutePath: (p) => path.join(work, p),
};
try {
  const parent = path.join(work, "parent");
  const child = path.join(parent, "child");
  fs.mkdirSync(child, { recursive: true });
  const markers = [parent, child].map((root) =>
    path.join(root, "Project.m1prj"),
  );
  markers.forEach((file) => fs.writeFileSync(file, "<Project/>"));
  const uri = (fsPath) => ({
    scheme: "file",
    fsPath,
    toString: () => pathToFileURL(fsPath).href,
  });
  let discovered = markers.map(uri);
  let delayDiscovery;
  const log = [],
    messages = [],
    instances = [],
    watchers = [];
  const rawChannels = [];
  const createRawChannel = (name) => {
    const raw = {
      name,
      logLevel: 2,
      closed: false,
      writes: 0,
      dispose() {
        this.closed = true;
      },
      onDidChangeLogLevel() {
        assert(!this.closed);
        return { dispose() {} };
      },
    };
    for (const method of [
      "append",
      "appendLine",
      "replace",
      "clear",
      "hide",
      "show",
      "trace",
      "debug",
      "info",
      "warn",
      "error",
    ]) {
      raw[method] = () => {
        assert(!raw.closed, "write after raw channel disposal");
        raw.writes++;
      };
    }
    rawChannels.push(raw);
    return raw;
  };
  const vscode = {
    Disposable: class {
      constructor(dispose) {
        this.dispose = dispose;
      }
    },
    Uri: { file: uri, parse: (value) => uri(fileURLToPath(value)) },
    RelativePattern: class {
      constructor(baseUri, pattern) {
        Object.assign(this, { baseUri, pattern });
      }
    },
    workspace: {
      workspaceFolders: [{ uri: uri(parent) }],
      getConfiguration: () => ({
        get: (name) => (name === "server.path" ? process.execPath : "off"),
      }),
      findFiles: async () => {
        if (delayDiscovery) await delayDiscovery;
        return discovered;
      },
      createFileSystemWatcher: (pattern) => {
        const watcher = {
          pattern,
          disposed: false,
          dispose() {
            this.disposed = true;
          },
          onDidCreate(fn) {
            this.created = fn;
          },
          onDidDelete(fn) {
            this.deleted = fn;
          },
        };
        watchers.push(watcher);
        return watcher;
      },
      onDidChangeWorkspaceFolders: (fn) => {
        vscode.folderChanged = fn;
        return { dispose() {} };
      },
    },
    window: {
      createOutputChannel: createRawChannel,
      showErrorMessage: async (message) => {
        messages.push(message);
      },
    },
  };
  const protocol = {
    CancellationToken: { None: {} },
    State: { Running: 2, Stopped: 3 },
    TransportKind: { stdio: 0 },
    Trace: { fromString: (x) => x },
    LanguageClient: class {
      constructor(id, name, server, options) {
        this.options = options;
        this.root = options.workspaceFolder?.uri.fsPath;
        this.features = [];
        instances.push(this);
      }
      registerFeature(feature) {
        this.features.push(feature);
      }
      onDidChangeState(fn) {
        this.onState = fn;
      }
      async start() {
        log.push(["start", this.root]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        this.onState({ newState: 2 });
      }
      async stop() {
        log.push(["stop", this.root]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        this.onState({ newState: 3 });
      }
      async setTrace() {}
    },
  };
  globalThis.__m1Routing = { vscode, protocol };
  for (const name of ["vscode", "protocol"])
    fs.writeFileSync(
      path.join(work, name + ".cjs"),
      `module.exports=globalThis.__m1Routing.${name}`,
    );
  const bundle = path.join(work, "client.cjs");
  await build({
    stdin: {
      contents:
        'export * from "./src/lsp-client";export { createLogChannel } from "./src/log-channel";',
      resolveDir: process.cwd(),
      loader: "ts",
    },
    outfile: bundle,
    bundle: true,
    platform: "node",
    logLevel: "silent",
    alias: {
      vscode: path.join(work, "vscode.cjs"),
      "vscode-languageclient/node": path.join(work, "protocol.cjs"),
    },
  });
  mod = require(bundle);
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay < 100) return nativeSetTimeout(callback, delay, ...args);
    const id = nextTimer++;
    timers.set(id, { callback: () => callback(...args), delay });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    if (!timers.delete(id)) nativeClearTimeout(id);
  };
  const shared = mod.createLogChannel("shared");
  context.subscriptions.push(shared);
  mod.initLspClient(shared, () => ({}));
  mod.watchProjectRoots(context);
  assert(
    watchers.some((w) => w.pattern.baseUri?.fsPath === work),
    "watch markers above the workspace",
  );
  await Promise.all([mod.syncClients(context), mod.syncClients(context)]);
  assert.equal(instances.length, 2, "concurrent scans start each root once");
  const p = instances.find((c) => c.root === parent),
    c = instances.find((c) => c.root === child);
  const own = uri(path.join(parent, "Own.m1scr")),
    nested = uri(path.join(child, "Child.m1scr"));
  let received = [];
  const push = (...args) => received.push(args);
  p.options.middleware.handleDiagnostics(nested, [], push);
  c.options.middleware.handleDiagnostics(nested, [], push);
  assert.equal(received.length, 1);
  const items = [{ uri: own }, { uri: nested }];
  const result = await p.options.middleware.provideWorkspaceDiagnostics(
    items,
    {},
    (chunk) => received.push(chunk),
    async (previous, token, report) => {
      assert.deepEqual(previous, [items[0]]);
      report({ items });
      return { items };
    },
  );
  assert.deepEqual(result.items, [items[0]]);
  assert.deepEqual(
    received.at(-1).items,
    [items[0]],
    "partial diagnostics are scoped too",
  );
  const related = await p.options.middleware.provideDiagnostics(
    own,
    undefined,
    {},
    async () => ({ relatedDocuments: { [own]: {}, [nested]: {} } }),
  );
  assert.deepEqual(Object.keys(related.relatedDocuments), [own.toString()]);
  received = [];
  for (const file of [own, nested])
    await p.options.middleware.workspace.didChangeWatchedFile(
      { uri: file.toString() },
      push,
    );
  assert.equal(received.length, 1);
  for (const name of [
    "parameters.m1cfg",
    "m1-tools.toml",
    ".m1lint.toml",
    ".m1fmt.toml",
  ]) {
    await c.options.middleware.workspace.didChangeWatchedFile(
      { uri: uri(path.join(parent, name)).toString() },
      push,
    );
  }
  assert.equal(
    received.length,
    5,
    "all shared ancestor config names remain observable",
  );
  await c.options.middleware.workspace.didChangeWatchedFile(
    { uri: uri(path.join(work, "sibling/.m1fmt.toml")).toString() },
    push,
  );
  assert.equal(received.length, 5, "unrelated sibling config is excluded");
  const files = [own, nested].map((oldUri) => ({ oldUri, newUri: oldUri }));
  await p.options.middleware.workspace.willRenameFiles(
    { files },
    async (event) => {
      assert.deepEqual(event.files, [files[0]]);
    },
  );
  await assert.rejects(
    p.options.middleware.handleRegisterCapability(
      {
        registrations: [
          { registerOptions: { documentSelector: [{ pattern: "**/*" }] } },
        ],
      },
      async () => assert.fail("must reject before registration"),
    ),
    /inherit/,
  );
  assert.throws(
    () =>
      p.features[0].preInitialize({ hoverProvider: { documentSelector: [] } }),
    /inherit/,
  );
  await p.options.middleware.handleRegisterCapability(
    { registrations: [{ registerOptions: {} }] },
    async () => {},
  );
  let finishSymbols, finishRename, finishFileRename;
  const staleSymbols = p.options.middleware.provideWorkspaceSymbols(
    "",
    {},
    () =>
      new Promise((resolve) => {
        finishSymbols = resolve;
      }),
  );
  const staleRename = p.options.middleware.provideRenameEdits(
    { uri: own },
    {},
    "Changed",
    {},
    () =>
      new Promise((resolve) => {
        finishRename = resolve;
      }),
  );
  const staleFileRename = p.options.middleware.workspace.willRenameFiles(
    { files },
    () =>
      new Promise((resolve) => {
        finishFileRename = resolve;
      }),
  );
  fs.unlinkSync(markers[1]);
  discovered = [uri(markers[0])];
  await mod.syncClients(context);
  p.onState({ newState: 3 });
  assert.equal(
    messages.length,
    0,
    "retired clients cannot prompt for recovery",
  );
  let staleRegistrations = 0;
  await p.options.middleware.handleRegisterCapability(
    { registrations: [{ registerOptions: {} }] },
    async () => {
      staleRegistrations++;
    },
  );
  assert.equal(
    staleRegistrations,
    0,
    "retired clients cannot register providers",
  );
  assert.deepEqual(
    log.slice(2),
    [
      ["stop", parent],
      ["stop", child],
      ["start", parent],
    ],
    "all old providers stop before the broad replacement starts",
  );
  assert.equal(mod.clients.size, 1);
  assert.equal(
    mod.clients.values().next().value.documentSelector.length,
    2,
    "single-root untitled behavior retained",
  );
  finishSymbols([{ location: { uri: own } }]);
  finishRename({ changes: "stale" });
  finishFileRename({ changes: "stale" });
  assert.deepEqual(await staleSymbols, []);
  assert.equal(await staleRename, undefined);
  assert.equal(await staleFileRename, undefined);
  const beforePublication = received.length;
  p.options.middleware.handleDiagnostics(own, [], push);
  assert.equal(
    received.length,
    beforePublication,
    "retired clients cannot publish",
  );

  // No watcher events at all: both a later marker and its deletion converge.
  fs.writeFileSync(markers[1], "<Project/>");
  discovered = markers.map(uri);
  await heartbeat();
  assert.deepEqual([...mod.clients.keys()].sort(), [parent, child].sort());
  const unchanged = instances.length;
  await heartbeat();
  assert.equal(
    instances.length,
    unchanged,
    "unchanged polling retains clients",
  );
  const crashed = mod.clients.get(child).client;
  crashed.onState({ newState: 3 });
  await settle();
  const crashMessages = messages.length;
  await heartbeat();
  await heartbeat();
  assert.equal(
    instances.length,
    unchanged,
    "polling does not retry a crashed client",
  );
  assert.equal(messages.length, crashMessages);
  await mod.restartClients(context);
  assert(
    mod.clients.has(child),
    "explicit restart still retries a missing client",
  );
  fs.unlinkSync(markers[1]);
  discovered = [uri(markers[0])];
  await heartbeat();
  assert.equal(mod.clients.size, 1);
  fs.writeFileSync(path.join(work, "Project.m1prj"), "<Project/>");
  fs.unlinkSync(markers[0]);
  discovered = [];
  await heartbeat();
  assert.equal(
    mod.clients.values().next().value.root,
    work,
    "ancestor markers converge without events",
  );

  const before = instances.length;
  let release;
  delayDiscovery = new Promise((resolve) => {
    release = resolve;
  });
  await heartbeat();
  assert.equal(
    timers.size,
    0,
    "a slow discovery cannot accumulate heartbeat work",
  );
  const pending = mod.syncClients(context);
  const stopping = mod.stopAllClients();
  // VS Code disposes subscriptions before awaiting the deactivate promise.
  for (const disposable of context.subscriptions) disposable.dispose();
  release();
  await Promise.all([pending, stopping, mod.syncClients(context)]);
  assert.equal(mod.clients.size, 0);
  assert.equal(
    instances.length,
    before,
    "queued reconciliation cannot restart after shutdown",
  );
  assert.equal(timers.size, 0, "shutdown cannot re-arm the heartbeat");
  assert.equal(messages.length, crashMessages);
  for (const instance of instances) {
    instance.options.outputChannel.info("late process exit");
    instance.options.outputChannel.error("late stderr");
  }
  shared.appendLine("late lifecycle completion");
  assert(rawChannels.every((channel) => channel.closed));
  console.log(
    "diagnostics, file events, selector contracts and serialized lifecycle passed",
  );
} finally {
  if (mod) await mod.stopAllClients();
  for (const disposable of context.subscriptions) disposable.dispose();
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
  delete globalThis.__m1Routing;
  fs.rmSync(work, { recursive: true, force: true });
}
