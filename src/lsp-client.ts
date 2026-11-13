import * as fs from "fs";
import { createLogChannel } from "./log-channel";
import * as path from "path";
import * as vscode from "vscode";
import {
  CancellationToken,
  CloseAction,
  DocumentSelector,
  ErrorAction,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State,
  Trace,
  TransportKind,
} from "vscode-languageclient/node";

import { containsPath, ownedPatterns, owningRoot } from "./project-ownership";

import { PROJECT_MARKER, resolveBin, walkUpToProject } from "./utils";

const SERVER_BIN = process.platform === "win32" ? "m1-lsp.exe" : "m1-lsp";

/** One running language server, scoped to a single project root. */
export interface ManagedClient {
  client: LanguageClient;
  output: vscode.OutputChannel;
  /** The project root this client is rooted at, or undefined in project-less mode. */
  root: string | undefined;
  /**
   * The document selector this client was started with. Retained so tests (and
   * diagnostics) can verify a *scoped* client really is anchored to its root —
   * a bare-glob selector silently over-claims every `.m1scr` in the workspace.
   */
  documentSelector: DocumentSelector;
  /**
   * The file-system watchers handed to the client via `synchronize.fileEvents`.
   * vscode-languageclient hooks listeners onto these (registerRaw) but never
   * disposes the watchers themselves, so we own them and dispose them when this
   * client is torn down — otherwise every restart/re-sync leaks them.
   */
  watchers: vscode.Disposable[];
  owns(uri: vscode.Uri): boolean;
  retire(): void;
}

/**
 * Build the document selector for a client.
 *
 * A *scoped* client (multi-root, #20) must claim only the `.m1scr` files under
 * its own `rootUri`. That requires an **anchored relative pattern** — the LSP
 * `{ baseUri, pattern }` form — NOT a bare `**​/*.m1scr` glob string. A
 * plain-string pattern is matched against the document's *absolute* path with
 * no workspace-folder anchoring, so every per-root server would claim every
 * `.m1scr` in the workspace — duplicate diagnostics/hover/completion and
 * ambiguous go-to-definition/rename. vscode-languageclient turns the
 * `{ baseUri, pattern }` filter back into a real `vscode.RelativePattern`
 * (anchored to `baseUri`) when it registers the providers.
 *
 * The single / project-less client claims every `.m1scr` (including files
 * outside any root and untitled buffers).
 */
export function buildDocumentSelector(
  rootUri: vscode.Uri | undefined,
  scoped: boolean,
  roots: readonly string[] = [],
): DocumentSelector {
  if (scoped && rootUri) {
    const excluded = roots
      .filter(
        (root) => root !== rootUri.fsPath && containsPath(rootUri.fsPath, root),
      )
      .map((root) => path.relative(rootUri.fsPath, root).split(path.sep));
    return ownedPatterns(excluded).map(({ base, pattern }) => ({
      scheme: "file",
      language: "m1scr",
      pattern: {
        baseUri: vscode.Uri.file(path.join(rootUri.fsPath, base)).toString(),
        pattern,
      },
    }));
  }
  return [
    { scheme: "file", language: "m1scr" },
    { scheme: "untitled", language: "m1scr" },
  ];
}

// Each project root gets its own client + server, keyed by the root's fsPath.
// The project-less / single-root fast path uses the SINGLE sentinel key so it is
// torn down cleanly when the workspace gains a second project.
const SINGLE = " single";

/** Every running language server, keyed by project-root fsPath (or SINGLE). */
export const clients = new Map<string, ManagedClient>();

// Keys of clients being stopped intentionally (restart/deactivate/re-sync), so
// the crash handler does not mistake a deliberate shutdown for an unexpected exit.
const suppressCrash = new Set<string>();

let output: vscode.LogOutputChannel;
let currentServerPath: string | undefined;
const projectOutputs = new Map<string, vscode.LogOutputChannel>();
let lifecycle: Promise<void> = Promise.resolve();
let shuttingDown = false;
let rootSnapshot: readonly string[] | undefined;

function enqueue(action: () => Promise<void>): Promise<void> {
  const next = lifecycle.then(action);
  lifecycle = next.catch((error) =>
    output.appendLine(`M1 client lifecycle failed: ${String(error)}`),
  );
  return next;
}
let buildSettings: (folder?: vscode.Uri) => Record<string, unknown>;
// Called whenever the set of live clients changes (start / stop / crash) so the
// status bar can re-render. Kept as a callback (not a direct import of
// status-bar) so lsp-client stays free of a circular import; extension.ts wires
// `refreshStatusBar` in via initLspClient.
let notifyClientsChanged: () => void = () => {};

/**
 * Wire the lifecycle module to the extension's shared output channel, the
 * `buildSettings` helper and the status-bar refresh (all kept in extension.ts
 * to avoid a circular import). Must be called once from `activate` before any
 * client is started.
 */
export function initLspClient(
  sharedOutput: vscode.LogOutputChannel,
  settingsFactory: (folder?: vscode.Uri) => Record<string, unknown>,
  onClientsChanged: () => void = () => {},
): void {
  output = sharedOutput;
  shuttingDown = false;
  rootSnapshot = undefined;
  buildSettings = settingsFactory;
  notifyClientsChanged = onClientsChanged;
}

/**
 * Apply the user's `m1.trace.server` level to a running client. The client id is
 * "m1-lsp", so vscode-languageclient would look for `m1-lsp.trace.server` on its
 * own; we keep the documented `m1.trace.server` namespace working by bridging it
 * here. Safe to call before the client is running — setTrace then throws and we
 * swallow it; it is re-applied after a successful start and on config change.
 */
export async function applyTrace(client: LanguageClient): Promise<void> {
  const level = vscode.workspace
    .getConfiguration("m1")
    .get<string>("trace.server", "off");
  try {
    await client.setTrace(Trace.fromString(level));
  } catch {
    // Client not running yet (or shutting down); re-applied on next start/change.
  }
}

/** Re-apply `m1.trace.server` to every running client (config-change handler). */
export function applyTraceToAll(): void {
  for (const { client } of clients.values()) {
    void applyTrace(client);
  }
}

/**
 * Resolve the m1-lsp server binary in priority order:
 *   1. `m1.server.path` setting (supports ~ and ${workspaceFolder}).
 *   2. A binary bundled under the extension's `server/` directory.
 *   3. `m1-lsp` discovered on the system PATH.
 */
export function resolveServerPath(
  context: vscode.ExtensionContext,
): string | undefined {
  return resolveBin(context, "server.path", SERVER_BIN, (line) =>
    output.appendLine(line),
  );
}

/**
 * Discover every distinct M1 project root in the workspace: walk up from each
 * workspace folder (matching m1-lsp's ancestor-only discovery), plus any
 * `Project.m1prj` nested below an opened folder. Sorted + deduplicated.
 */
async function discoverProjectRoots(): Promise<string[]> {
  const roots = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = walkUpToProject(folder.uri.fsPath);
    if (root) {
      roots.add(root);
    }
  }
  const nested = await vscode.workspace.findFiles(
    `**/${PROJECT_MARKER}`,
    "**/node_modules/**",
  );
  for (const f of nested) {
    roots.add(path.dirname(f.fsPath));
  }
  return [...roots].sort();
}

/**
 * Reconcile the running servers with the discovered project roots.
 *   - 0 or 1 root: one client (the single-root fast path), rooted at that project
 *     or project-less, serving every `.m1scr` (current behaviour).
 *   - 2+ roots: one client per root, each scoped to its folder so a `.m1scr`
 *     under root A is served only by A's server (#20).
 */
export function syncClients(context: vscode.ExtensionContext): Promise<void> {
  return enqueue(() => reconcileClients(context, false));
}

export function restartClients(
  context: vscode.ExtensionContext,
): Promise<void> {
  return enqueue(() => reconcileClients(context, true));
}

async function reconcileClients(
  context: vscode.ExtensionContext,
  force: boolean,
  retryMissing = true,
): Promise<void> {
  if (shuttingDown) return;
  const roots = await discoverProjectRoots();
  if (shuttingDown) return;
  const changed = JSON.stringify(rootSnapshot) !== JSON.stringify(roots);
  if (!force && !changed && !retryMissing) return;
  if (force || changed) {
    // Retire every provider before registering the new partition. The new
    // clients' didOpen registrations replay current, possibly unsaved text.
    for (const managed of clients.values()) managed.retire();
    for (const key of [...clients.keys()]) await stopClientFor(key);
    rootSnapshot = roots;
  }
  const scoped = roots.length >= 2;
  for (const root of scoped ? roots : [roots[0]]) {
    if (shuttingDown) return;
    const key = scoped ? root : SINGLE;
    if (!clients.has(key)) await startClient(context, root, scoped, roots);
  }
}

/** Track project creation/removal, including markers above an opened folder. */
export function watchProjectRoots(context: vscode.ExtensionContext): void {
  let watchers: vscode.Disposable[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let eventPending = false;
  let rescanRequested = false;
  const scheduleHeartbeat = () => {
    if (disposed || shuttingDown) return;
    heartbeat = setTimeout(() => {
      heartbeat = undefined;
      if (disposed || shuttingDown) return;
      // Watcher readiness is not exposed, and events can be lost. Keep one
      // recovery scan outstanding, with the next due after this one settles.
      void enqueue(() => reconcileClients(context, false, false))
        .catch(() => {}) // enqueue already logged the error.
        .finally(scheduleHeartbeat);
    }, 1000);
  };
  const changed = () => {
    if (disposed || shuttingDown) return;
    if (eventPending) {
      rescanRequested = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      eventPending = true;
      void syncClients(context)
        .catch((error) => {
          if (!disposed && !shuttingDown)
            void vscode.window.showErrorMessage(
              `Failed to refresh M1 projects: ${String(error)}`,
            );
        })
        .finally(() => {
          eventPending = false;
          if (rescanRequested) {
            rescanRequested = false;
            changed();
          }
        });
    }, 100);
  };
  const rebuild = () => {
    for (const watcher of watchers) watcher.dispose();
    const ancestors = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (
        let dir = path.dirname(folder.uri.fsPath);
        ;
        dir = path.dirname(dir)
      ) {
        ancestors.add(dir);
        if (path.dirname(dir) === dir) break;
      }
    }
    const patterns: vscode.GlobPattern[] = [
      "**",
      ...[...ancestors].map(
        (dir) =>
          new vscode.RelativePattern(vscode.Uri.file(dir), PROJECT_MARKER),
      ),
    ];
    watchers = patterns.map((pattern) => {
      const watcher = vscode.workspace.createFileSystemWatcher(
        pattern,
        false,
        true,
        false,
      );
      watcher.onDidCreate((uri) => {
        // A copied/new directory can arrive as one event without events for
        // the marker files already inside it.
        if (path.basename(uri.fsPath) === PROJECT_MARKER) {
          changed();
          return;
        }
        try {
          if (fs.statSync(uri.fsPath).isDirectory()) changed();
        } catch {
          /* Already removed. */
        }
      });
      watcher.onDidDelete((uri) => {
        if (
          path.basename(uri.fsPath) === PROJECT_MARKER ||
          rootSnapshot?.some((root) => containsPath(uri.fsPath, root))
        )
          changed();
      });
      return watcher;
    });
  };
  rebuild();
  scheduleHeartbeat();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      rebuild();
      changed();
    }),
    {
      dispose() {
        disposed = true;
        if (timer) clearTimeout(timer);
        if (heartbeat) clearTimeout(heartbeat);
        for (const watcher of watchers) watcher.dispose();
        projectOutputs.clear();
      },
    },
  );
}

/**
 * Start one server rooted at `root` (undefined = project-less). When `scoped`,
 * the client only handles `.m1scr` files *under* `root` and gets its own named
 * output channel, so multiple project servers don't fight over the same files.
 */
async function startClient(
  context: vscode.ExtensionContext,
  root: string | undefined,
  scoped: boolean,
  roots: readonly string[],
): Promise<void> {
  const serverPath = resolveServerPath(context);
  if (!serverPath) {
    const choice = await vscode.window.showErrorMessage(
      "m1-lsp server binary not found. Set 'm1.server.path', bundle it under the extension's server/ directory, or put 'm1-lsp' on your PATH.",
      "Open Settings",
    );
    if (choice === "Open Settings") {
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "m1.server.path",
      );
    }
    return;
  }
  currentServerPath = serverPath;

  const key = scoped ? (root as string) : SINGLE;
  const name = root ? path.basename(root) || "m1" : "m1";
  // Scoped clients log to their own channel so output is attributable per project.
  let chan = output;
  if (scoped) {
    chan = projectOutputs.get(root!)!;
    if (!chan) {
      chan = createLogChannel(`M1 LSP — ${name}`);
      projectOutputs.set(root!, chan);
      context.subscriptions.push(chan);
    }
  }
  chan.appendLine(`Starting m1-lsp: ${serverPath}`);
  chan.appendLine(
    root
      ? `Project root: ${root}`
      : `No ${PROJECT_MARKER} found; running without project context (go-to-definition will be limited).`,
  );

  const serverOptions: ServerOptions = {
    run: { command: serverPath, transport: TransportKind.stdio },
    debug: { command: serverPath, transport: TransportKind.stdio },
  };

  const rootUri = root ? vscode.Uri.file(root) : undefined;
  // A scoped client only claims documents under its root; the single client
  // claims every .m1scr (incl. project-less files outside any root).
  const documentSelector = buildDocumentSelector(rootUri, scoped, roots);
  let active = true;
  const owns = (uri: vscode.Uri) =>
    active &&
    (!scoped ||
      (uri.scheme === "file" && owningRoot(roots, uri.fsPath) === root));
  // Config discovery may use a shared ancestor file outside this root.
  const observes = (uri: vscode.Uri) =>
    active &&
    (owns(uri) ||
      (uri.scheme === "file" &&
        root !== undefined &&
        containsPath(path.dirname(uri.fsPath), root) &&
        (path.extname(uri.fsPath) === ".m1cfg" ||
          ["m1-tools.toml", ".m1lint.toml", ".m1fmt.toml"].includes(
            path.basename(uri.fsPath),
          ))));
  const requireDefaultSelector = (options: unknown): void => {
    if (
      scoped &&
      options &&
      typeof options === "object" &&
      "documentSelector" in options &&
      options.documentSelector != null
    ) {
      throw new Error(
        "Scoped M1 servers must inherit the client's document selector",
      );
    }
  };

  // Watch the script sources plus every file the server's project model is
  // built from, so it is told (via workspace/didChangeWatchedFiles) when any
  // of them change: .m1prj (the project), parameters.m1cfg (parameter value
  // types), .m1dbc (CAN signal metadata) and m1-tools.toml (workspace
  // config). Without .m1cfg/.m1dbc here, edits to those files left hover/
  // completion/diagnostics stale until a server restart (#104). The non-source
  // events drive a lightweight reload (see reloadProjectClients), not a
  // restart.
  const watchGlobs = [
    "**/*.m1scr",
    "**/*.m1prj",
    "**/*.m1cfg",
    "**/*.m1dbc",
    "**/m1-tools.toml",
  ];
  // Workspace folders are already watched recursively; ownership middleware
  // filters these shared events for each client.
  const watchRoot =
    rootUri &&
    !(vscode.workspace.workspaceFolders ?? []).some((folder) =>
      containsPath(folder.uri.fsPath, rootUri.fsPath),
    )
      ? rootUri
      : undefined;
  const fileEvents = watchGlobs.map((glob) =>
    vscode.workspace.createFileSystemWatcher(
      watchRoot ? new vscode.RelativePattern(watchRoot, glob) : glob,
    ),
  );

  const clientOptions: LanguageClientOptions = {
    documentSelector,
    // Recovery must pass through our queue and create a fresh ownership snapshot.
    connectionOptions: { maxRestartCount: 0 },
    middleware: {
      handleDiagnostics(uri, diagnostics, next) {
        if (owns(uri)) next(uri, diagnostics);
      },
      async provideDiagnostics(document, previous, token, next) {
        const report = await next(document, previous, token);
        if (!active) return undefined;
        if (report?.relatedDocuments) {
          report.relatedDocuments = Object.fromEntries(
            Object.entries(report.relatedDocuments).filter(([uri]) =>
              owns(vscode.Uri.parse(uri)),
            ),
          );
        }
        return report;
      },
      async provideWorkspaceDiagnostics(previous, token, report, next) {
        const result = await next(
          previous.filter((item) => owns(item.uri)),
          token,
          (chunk) =>
            report(
              chunk && { items: chunk.items.filter((item) => owns(item.uri)) },
            ),
        );
        return (
          result && { items: result.items.filter((item) => owns(item.uri)) }
        );
      },
      async provideWorkspaceSymbols(query, token, next) {
        const symbols = await next(query, token);
        return symbols?.filter((symbol) => owns(symbol.location.uri));
      },
      async provideRenameEdits(document, position, newName, token, next) {
        if (!active) return undefined;
        const result = await next(document, position, newName, token);
        return active ? result : undefined;
      },
      async handleRegisterCapability(params, next) {
        for (const registration of params.registrations)
          requireDefaultSelector(registration.registerOptions);
        await next(params, CancellationToken.None);
      },
      workspace: {
        async didChangeWatchedFile(event, next) {
          if (observes(vscode.Uri.parse(event.uri))) await next(event);
        },
        async willRenameFiles(event, next) {
          const files = event.files.filter((file) => owns(file.oldUri));
          const result = files.length
            ? await next({ ...event, files })
            : undefined;
          return active ? result : undefined;
        },
        async didRenameFiles(event, next) {
          const files = event.files.filter((file) => owns(file.oldUri));
          if (files.length) await next({ ...event, files });
        },
        async willCreateFiles(event, next) {
          const files = event.files.filter(owns);
          const result = files.length
            ? await next({ ...event, files })
            : undefined;
          return active ? result : undefined;
        },
        async didCreateFiles(event, next) {
          const files = event.files.filter(owns);
          if (files.length) await next({ ...event, files });
        },
        async willDeleteFiles(event, next) {
          const files = event.files.filter(owns);
          const result = files.length
            ? await next({ ...event, files })
            : undefined;
          return active ? result : undefined;
        },
        async didDeleteFiles(event, next) {
          const files = event.files.filter(owns);
          if (files.length) await next({ ...event, files });
        },
      },
    },
    outputChannel: chan,
    // The stopped-state handler owns crash recovery and its notification.
    errorHandler: {
      error: (_error, _message, count) => ({
        action:
          count && count <= 3 ? ErrorAction.Continue : ErrorAction.Shutdown,
      }),
      closed: () => ({ action: CloseAction.DoNotRestart, handled: true }),
    },
    // Pin the server's root to the project dir. vscode-languageclient derives
    // both rootUri and workspaceFolders from clientOptions.workspaceFolder when set.
    workspaceFolder: rootUri ? { uri: rootUri, name, index: 0 } : undefined,
    synchronize: {
      fileEvents,
    },
    // The user's m1.* settings (the editor config layer), read at *this
    // client's own root* so per-folder overrides in a multi-root workspace
    // reach the right server; a workspace m1-tools.toml, which the server
    // discovers itself, overrides these.
    initializationOptions: { settings: buildSettings(rootUri) },
  };

  const client = new LanguageClient(
    "m1-lsp",
    `M1 Language Server${scoped ? ` (${name})` : ""}`,
    serverOptions,
    clientOptions,
  );
  client.registerFeature({
    fillClientCapabilities() {},
    preInitialize(capabilities) {
      for (const value of Object.values(capabilities))
        requireDefaultSelector(value);
    },
    initialize() {},
    getState: () => ({ kind: "static" }),
    clear() {},
  });
  clients.set(key, {
    client,
    output: chan,
    root,
    documentSelector,
    watchers: fileEvents,
    owns,
    retire: () => {
      active = false;
    },
  });

  // Detect an unexpected server exit (a crash) and offer to restart just this one.
  client.onDidChangeState((event) => {
    // A new managed start changes what the status bar should show.
    if (event.newState === State.Running) {
      notifyClientsChanged();
      return;
    }
    if (event.newState !== State.Stopped || suppressCrash.has(key)) {
      return;
    }
    // Unexpected exit: drop the dead client from the map so the status bar and
    // diagnostics stop counting a server that isn't running. (A deliberate stop
    // is suppressed above and cleaned up by stopClientFor.) Dispose the watchers
    // to avoid leaking one per watch glob; keep the output channel alive so
    // "Show Output" still shows the crash — it is disposed on deactivate via
    // context.subscriptions.
    const dead = clients.get(key);
    if (dead && dead.client === client) {
      dead.retire();
      clients.delete(key);
      for (const w of dead.watchers) {
        w.dispose();
      }
    }
    notifyClientsChanged();
    chan.appendLine("m1-lsp stopped unexpectedly.");
    void vscode.window
      .showErrorMessage(
        `M1 language server${scoped ? ` for ${name}` : ""} stopped unexpectedly.`,
        "Restart",
        "Show Output",
      )
      .then((choice) => {
        if (choice === "Restart") {
          void syncClients(context);
        } else if (choice === "Show Output") {
          chan.show();
        }
      });
  });

  try {
    suppressCrash.delete(key);
    await client.start();
    chan.appendLine("m1-lsp started.");
    void applyTrace(client);
    notifyClientsChanged();
  } catch (err) {
    active = false;
    chan.appendLine(`Failed to start m1-lsp: ${String(err)}`);
    void vscode.window.showErrorMessage(
      `Failed to start m1-lsp: ${String(err)}`,
    );
    clients.delete(key);
    for (const w of fileEvents) {
      w.dispose();
    }
    notifyClientsChanged();
  }
}

/** Stop and forget the client under `key` (a no-op if none). */
async function stopClientFor(key: string): Promise<void> {
  const managed = clients.get(key);
  if (!managed) {
    return;
  }
  managed.retire();
  suppressCrash.add(key);
  clients.delete(key);
  await managed.client.stop().catch(() => undefined);
  // vscode-languageclient disposes the listeners it hooked onto these watchers
  // but not the watchers themselves; dispose them here so we don't leak one per
  // watch glob on every restart / multi-root re-sync.
  for (const w of managed.watchers) {
    w.dispose();
  }
  // The child process can log its exit after stop resolves. Keep each root's
  // channel for the extension lifetime and reuse it on subsequent starts.
  suppressCrash.delete(key);
  notifyClientsChanged();
}

/** Stop every running client. */
export function stopAllClients(): Promise<void> {
  shuttingDown = true;
  for (const managed of clients.values()) managed.retire();
  return enqueue(async () => {
    for (const key of [...clients.keys()]) await stopClientFor(key);
    rootSnapshot = undefined;
  });
}

/** Build the diagnostic-info text (versions, paths, per-client capabilities). */
export function describeClients(context: vscode.ExtensionContext): string {
  const pkg = context.extension.packageJSON as {
    version?: string;
    m1?: { serverVersion?: string };
  };
  const stateName = (s: State | undefined): string =>
    s === State.Running
      ? "Running"
      : s === State.Starting
        ? "Starting"
        : s === State.Stopped
          ? "Stopped"
          : "Not started";

  const managed = [...clients.values()];
  // The truth about what is actually running comes from the initialize
  // result, not the bundled pin: with a custom m1.serverPath (or a stale
  // bundle) the two diverge, and showing only the pin lies to the user (#97).
  const running = managed
    .map(
      (m) =>
        (m.client.initializeResult?.serverInfo as { version?: string })
          ?.version,
    )
    .find((v) => v !== undefined);
  const pinned = pkg.m1?.serverVersion;
  // The server reports CARGO_PKG_VERSION ("0.36.0"); the pin carries a tag
  // prefix ("v0.36.0") — normalise before comparing.
  const mismatch =
    running !== undefined &&
    pinned !== undefined &&
    running.replace(/^v/, "") !== pinned.replace(/^v/, "");
  const lines = [
    "M1 Language Extension — Diagnostic Info",
    "========================================",
    `Extension version:  ${pkg.version ?? "(unknown)"}`,
    `Server version:     ${running ?? "(server not started)"}`,
    `Bundled pin:        ${pinned ?? "(unknown)"}${
      mismatch
        ? "  ⚠ running server differs from the pin (custom serverPath or stale bundle — restart the server after updates)"
        : ""
    }`,
    `Server path:        ${currentServerPath ?? "(not resolved)"}`,
    `Active servers:     ${managed.length}`,
    "",
  ];

  if (managed.length === 0) {
    lines.push("(no language server running)");
  }
  for (const { client, root } of managed) {
    const caps = client.initializeResult?.capabilities as
      Record<string, unknown> | undefined;
    const cap = (key: string): string =>
      caps ? (caps[key] ? "true" : "false") : "(server not started)";
    const projectFile = root ? path.join(root, PROJECT_MARKER) : undefined;
    lines.push(
      `Project root:       ${root ?? "(none — project-less mode)"}`,
      `  status:                     ${stateName(client.state)}`,
      `  project file:               ${
        projectFile && fs.existsSync(projectFile) ? projectFile : "(none)"
      }`,
      `  hoverProvider:              ${cap("hoverProvider")}`,
      `  completionProvider:         ${cap("completionProvider")}`,
      `  definitionProvider:         ${cap("definitionProvider")}`,
      `  referencesProvider:         ${cap("referencesProvider")}`,
      `  renameProvider:             ${cap("renameProvider")}`,
      `  documentSymbolProvider:     ${cap("documentSymbolProvider")}`,
      `  inlayHintProvider:          ${cap("inlayHintProvider")}`,
      `  semanticTokensProvider:     ${cap("semanticTokensProvider")}`,
      `  callHierarchyProvider:      ${cap("callHierarchyProvider")}`,
      `  codeLensProvider:           ${cap("codeLensProvider")}`,
      `  documentFormattingProvider: ${cap("documentFormattingProvider")}`,
      "",
    );
  }

  return lines.join("\n") + "\n";
}
