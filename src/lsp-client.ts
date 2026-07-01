import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  DocumentSelector,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State,
  TransportKind,
} from "vscode-languageclient/node";

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
): DocumentSelector {
  if (scoped && rootUri) {
    return [
      {
        scheme: "file",
        language: "m1scr",
        // The LSP relative-pattern form: an anchored { baseUri, pattern }, not
        // a bare glob string — see the doc comment above.
        pattern: { baseUri: rootUri.toString(), pattern: "**/*.m1scr" },
      },
    ];
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
let buildSettings: () => Record<string, unknown>;

/**
 * Wire the lifecycle module to the extension's shared output channel and the
 * `buildSettings` helper (kept in extension.ts to avoid a circular import).
 * Must be called once from `activate` before any client is started.
 */
export function initLspClient(
  sharedOutput: vscode.LogOutputChannel,
  settingsFactory: () => Record<string, unknown>,
): void {
  output = sharedOutput;
  buildSettings = settingsFactory;
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
export async function syncClients(
  context: vscode.ExtensionContext,
): Promise<void> {
  const roots = await discoverProjectRoots();

  if (roots.length >= 2) {
    // Multi-root: tear down the single-root client, then one scoped client/root.
    if (clients.has(SINGLE)) {
      await stopClientFor(SINGLE);
    }
    const desired = new Set(roots);
    for (const key of [...clients.keys()]) {
      if (!desired.has(key)) {
        await stopClientFor(key);
      }
    }
    for (const root of roots) {
      if (!clients.has(root)) {
        await startClient(context, root, true);
      }
    }
    return;
  }

  // Single-root / project-less fast path: exactly one client under SINGLE.
  for (const key of [...clients.keys()]) {
    if (key !== SINGLE) {
      await stopClientFor(key);
    }
  }
  const root = roots[0];
  const existing = clients.get(SINGLE);
  if (existing && existing.root === root) {
    return; // already rooted correctly
  }
  if (existing) {
    await stopClientFor(SINGLE);
  }
  await startClient(context, root, false);
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
  const chan = scoped
    ? vscode.window.createOutputChannel(`M1 LSP — ${name}`, { log: true })
    : output;
  context.subscriptions.push(chan);
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
  const documentSelector = buildDocumentSelector(rootUri, scoped);

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
  const fileEvents = watchGlobs.map((glob) =>
    vscode.workspace.createFileSystemWatcher(
      rootUri ? new vscode.RelativePattern(rootUri, glob) : glob,
    ),
  );

  const clientOptions: LanguageClientOptions = {
    documentSelector,
    outputChannel: chan,
    // Pin the server's root to the project dir. vscode-languageclient derives
    // both rootUri and workspaceFolders from clientOptions.workspaceFolder when set.
    workspaceFolder: rootUri ? { uri: rootUri, name, index: 0 } : undefined,
    synchronize: {
      fileEvents,
    },
    // The user's m1.* settings (the editor config layer); a workspace
    // m1-tools.toml, which the server discovers itself, overrides these.
    initializationOptions: { settings: buildSettings() },
  };

  const client = new LanguageClient(
    "m1-lsp",
    `M1 Language Server${scoped ? ` (${name})` : ""}`,
    serverOptions,
    clientOptions,
  );
  clients.set(key, {
    client,
    output: chan,
    root,
    documentSelector,
    watchers: fileEvents,
  });

  // Detect an unexpected server exit (a crash) and offer to restart just this one.
  client.onDidChangeState((event) => {
    if (event.newState !== State.Stopped || suppressCrash.has(key)) {
      return;
    }
    chan.appendLine("m1-lsp stopped unexpectedly.");
    void vscode.window
      .showErrorMessage(
        `M1 language server${scoped ? ` for ${name}` : ""} stopped unexpectedly.`,
        "Restart",
        "Show Output",
      )
      .then((choice) => {
        if (choice === "Restart") {
          void vscode.commands.executeCommand("m1.restartServer");
        } else if (choice === "Show Output") {
          chan.show();
        }
      });
  });

  try {
    suppressCrash.delete(key);
    await client.start();
    chan.appendLine("m1-lsp started.");
  } catch (err) {
    chan.appendLine(`Failed to start m1-lsp: ${String(err)}`);
    void vscode.window.showErrorMessage(
      `Failed to start m1-lsp: ${String(err)}`,
    );
    clients.delete(key);
  }
}

/** Stop and forget the client under `key` (a no-op if none). */
async function stopClientFor(key: string): Promise<void> {
  const managed = clients.get(key);
  if (!managed) {
    return;
  }
  suppressCrash.add(key);
  clients.delete(key);
  await managed.client.stop().catch(() => undefined);
  // vscode-languageclient disposes the listeners it hooked onto these watchers
  // but not the watchers themselves; dispose them here so we don't leak one per
  // watch glob on every restart / multi-root re-sync.
  for (const w of managed.watchers) {
    w.dispose();
  }
  if (managed.output !== output) {
    managed.output.dispose();
  }
  suppressCrash.delete(key);
}

/** Stop every running client. */
export async function stopAllClients(): Promise<void> {
  for (const key of [...clients.keys()]) {
    await stopClientFor(key);
  }
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
