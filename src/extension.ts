import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { promisify } from "util";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  State,
  TransportKind,
} from "vscode-languageclient/node";

const execFileAsync = promisify(execFile);

let client: LanguageClient | undefined;
let output: vscode.OutputChannel;
let currentRoot: string | undefined;
let currentServerPath: string | undefined;
// Set true around an intentional stop (restart/deactivate) so the crash handler
// does not mistake a deliberate shutdown for an unexpected exit.
let suppressCrashPrompt = false;

const SERVER_BIN = process.platform === "win32" ? "m1-lsp.exe" : "m1-lsp";
const PROJECT_MARKER = "Project.m1prj";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  output = vscode.window.createOutputChannel("M1 Language Server");
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("m1.showOutput", () => output.show()),
    vscode.commands.registerCommand("m1.restartServer", async () => {
      await stopClient();
      await startClient(context);
    }),
    vscode.commands.registerCommand("m1.showDiagnosticInfo", () =>
      showDiagnosticInfo(context),
    ),
    vscode.commands.registerCommand("m1.generateConfig", () =>
      generateConfig(context),
    ),
    // Push edited m1.* settings to the running server live (the middle config
    // layer beneath a workspace m1-tools.toml).
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("m1.lint") ||
        e.affectsConfiguration("m1.format") ||
        e.affectsConfiguration("m1.diagnostics")
      ) {
        void client?.sendNotification("workspace/didChangeConfiguration", {
          settings: buildSettings(),
        });
      }
    }),
    // Re-root the server when the user moves to an .m1scr in a different project.
    // m1-lsp loads its project once, from the initialize root, so switching
    // projects requires a restart with the new root.
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor?.document.languageId !== "m1scr") {
        return;
      }
      const root = await findProjectDir(editor.document.uri);
      if ((root?.fsPath ?? undefined) !== currentRoot) {
        output.appendLine(
          `Active M1 file changed project root -> ${root?.fsPath ?? "(none)"}; restarting server.`,
        );
        await stopClient();
        await startClient(context);
      }
    }),
  );

  await startClient(context);
}

export async function deactivate(): Promise<void> {
  await stopClient();
}

async function startClient(context: vscode.ExtensionContext): Promise<void> {
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
  output.appendLine(`Starting m1-lsp: ${serverPath}`);

  // m1-lsp discovers its project by walking *up* from the initialize root looking
  // for Project.m1prj; it never descends. VS Code's default root is the opened
  // folder, which is often an ancestor of (or unrelated to) the project, so the
  // server loads no project and features like go-to-definition return nothing.
  // Mirror the Neovim setup (root_markers = {Project.m1prj}) by rooting the
  // client at the project directory itself.
  const projectDir = await findProjectDir(
    vscode.window.activeTextEditor?.document.uri,
  );
  currentRoot = projectDir?.fsPath;
  output.appendLine(
    projectDir
      ? `Project root: ${projectDir.fsPath}`
      : `No ${PROJECT_MARKER} found; running without project context (go-to-definition will be limited).`,
  );

  const serverOptions: ServerOptions = {
    run: { command: serverPath, transport: TransportKind.stdio },
    debug: { command: serverPath, transport: TransportKind.stdio },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "m1scr" },
      { scheme: "untitled", language: "m1scr" },
    ],
    outputChannel: output,
    // Pin the server's root to the project dir. vscode-languageclient derives
    // both rootUri and workspaceFolders from clientOptions.workspaceFolder when
    // it is set, overriding the opened folder.
    workspaceFolder: projectDir
      ? {
          uri: projectDir,
          name: path.basename(projectDir.fsPath) || "m1",
          index: 0,
        }
      : undefined,
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.m1scr"),
    },
    // The user's m1.* settings (the editor config layer); a workspace
    // m1-tools.toml, which the server discovers itself, overrides these.
    initializationOptions: { settings: buildSettings() },
  };

  client = new LanguageClient(
    "m1-lsp",
    "M1 Language Server",
    serverOptions,
    clientOptions,
  );

  // Detect an unexpected server exit (a crash) and offer to restart. Intentional
  // stops (restart command, deactivate, project re-root) set suppressCrashPrompt.
  client.onDidChangeState((event) => {
    if (event.newState !== State.Stopped || suppressCrashPrompt) {
      return;
    }
    output.appendLine("m1-lsp stopped unexpectedly.");
    void vscode.window
      .showErrorMessage(
        "M1 language server stopped unexpectedly.",
        "Restart",
        "Show Output",
      )
      .then((choice) => {
        if (choice === "Restart") {
          void vscode.commands.executeCommand("m1.restartServer");
        } else if (choice === "Show Output") {
          output.show();
        }
      });
  });

  try {
    suppressCrashPrompt = false;
    await client.start();
    output.appendLine("m1-lsp started.");
  } catch (err) {
    output.appendLine(`Failed to start m1-lsp: ${String(err)}`);
    void vscode.window.showErrorMessage(
      `Failed to start m1-lsp: ${String(err)}`,
    );
  }
}

async function stopClient(): Promise<void> {
  if (client) {
    // Mark this as an intentional stop so the crash handler stays quiet.
    suppressCrashPrompt = true;
    await client.stop().catch(() => undefined);
    client = undefined;
  }
}

/**
 * Open a tab summarising the extension's current state — versions, the resolved
 * server path, client status, the active project, and the server capabilities
 * from the initialize response. Helps users verify their setup and file bugs.
 */
async function showDiagnosticInfo(
  context: vscode.ExtensionContext,
): Promise<void> {
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

  const caps = client?.initializeResult?.capabilities as
    | Record<string, unknown>
    | undefined;
  const cap = (key: string): string =>
    caps ? (caps[key] ? "true" : "false") : "(server not started)";

  const projectFile = currentRoot
    ? path.join(currentRoot, PROJECT_MARKER)
    : undefined;
  const lines = [
    "M1 Language Extension — Diagnostic Info",
    "========================================",
    `Extension version:  ${pkg.version ?? "(unknown)"}`,
    `Server version:     ${pkg.m1?.serverVersion ?? "(unknown)"} (pinned)`,
    `Server path:        ${currentServerPath ?? "(not resolved)"}`,
    `Server status:      ${stateName(client?.state)}`,
    `Project root:       ${currentRoot ?? "(none — project-less mode)"}`,
    `Project file:       ${
      projectFile && fs.existsSync(projectFile) ? projectFile : "(none)"
    }`,
    "",
    "Server capabilities (from initialize response):",
    `  hoverProvider:              ${cap("hoverProvider")}`,
    `  completionProvider:         ${cap("completionProvider")}`,
    `  definitionProvider:         ${cap("definitionProvider")}`,
    `  referencesProvider:         ${cap("referencesProvider")}`,
    `  renameProvider:             ${cap("renameProvider")}`,
    `  documentSymbolProvider:     ${cap("documentSymbolProvider")}`,
    `  inlayHintProvider:          ${cap("inlayHintProvider")}`,
    `  semanticTokensProvider:     ${cap("semanticTokensProvider")}`,
    `  documentFormattingProvider: ${cap("documentFormattingProvider")}`,
  ];

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join("\n") + "\n",
    language: "text",
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Collect the user's explicitly-set `m1.*` settings into the snake_case shape the
 * server's config layer expects (`{ lint, format, diagnostics }`). Only values the
 * user actually set (workspace/global) are included — defaults are left out so the
 * server falls back to its own, and a workspace `m1-tools.toml` can override.
 */
function buildSettings(): {
  lint: Record<string, unknown>;
  format: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
} {
  const cfg = vscode.workspace.getConfiguration("m1");
  const explicit = (key: string): unknown => {
    const i = cfg.inspect(key);
    return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
  };
  const settings = {
    lint: {} as Record<string, unknown>,
    format: {} as Record<string, unknown>,
    diagnostics: {} as Record<string, unknown>,
  };
  // [vsCodeSection.vsCodeKey, tomlSection, tomlKey]
  const map: [string, "lint" | "format" | "diagnostics", string][] = [
    ["lint.maxLineLength", "lint", "max_line_length"],
    ["lint.maxNestingDepth", "lint", "max_nesting_depth"],
    ["lint.maxComplexity", "lint", "max_complexity"],
    ["lint.exclude", "lint", "exclude"],
    ["format.lineWidth", "format", "line_width"],
    ["format.maxBlankLines", "format", "max_blank_lines"],
    ["diagnostics.ignore", "diagnostics", "ignore"],
    ["diagnostics.select", "diagnostics", "select"],
  ];
  for (const [vsKey, section, tomlKey] of map) {
    const v = explicit(vsKey);
    if (v !== undefined) {
      settings[section][tomlKey] = v;
    }
  }
  return settings;
}

/**
 * Generate a default `m1-tools.toml` in the workspace by running the bundled
 * server's `--scaffold-config` (so the file matches the shipped tool versions and
 * never drifts), then open it. Confirms before overwriting an existing file.
 */
async function generateConfig(context: vscode.ExtensionContext): Promise<void> {
  const serverPath = resolveServerPath(context);
  if (!serverPath) {
    void vscode.window.showErrorMessage(
      "m1-lsp server binary not found; cannot generate m1-tools.toml.",
    );
    return;
  }
  const root =
    currentRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showErrorMessage(
      "Open a folder/workspace before generating m1-tools.toml.",
    );
    return;
  }
  const target = path.join(root, "m1-tools.toml");
  if (fs.existsSync(target)) {
    const choice = await vscode.window.showWarningMessage(
      "m1-tools.toml already exists. Overwrite it with defaults?",
      "Overwrite",
      "Cancel",
    );
    if (choice !== "Overwrite") {
      return;
    }
  }
  try {
    const { stdout } = await execFileAsync(serverPath, ["--scaffold-config"]);
    fs.writeFileSync(target, stdout);
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
    void vscode.window.showInformationMessage(`Generated ${target}`);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Failed to generate m1-tools.toml: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Resolve the server binary in priority order:
 *   1. `m1.server.path` setting (supports ~ and ${workspaceFolder}).
 *   2. A binary bundled under the extension's `server/` directory.
 *   3. `m1-lsp` discovered on the system PATH.
 */
function resolveServerPath(
  context: vscode.ExtensionContext,
): string | undefined {
  const configured = vscode.workspace
    .getConfiguration("m1")
    .get<string>("server.path");
  if (configured && configured.trim().length > 0) {
    const expanded = expand(configured.trim());
    if (fs.existsSync(expanded)) {
      return expanded;
    }
    output.appendLine(`Configured m1.server.path does not exist: ${expanded}`);
  }

  const bundled = context.asAbsolutePath(path.join("server", SERVER_BIN));
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  const onPath = findOnPath(SERVER_BIN);
  if (onPath) {
    return onPath;
  }

  return undefined;
}

/**
 * Locate the M1 project directory (the one containing `Project.m1prj`) so the
 * language server can be rooted there. Resolution order:
 *   1. Walk up from the given .m1scr file (or the first workspace folder),
 *      matching m1-lsp's own ancestor-only discovery.
 *   2. Fall back to a workspace-wide search, to catch a project nested *below*
 *      the opened folder (e.g. opening a repo root whose project lives in a
 *      subdirectory).
 * Returns undefined when no project is found (project-less mode).
 */
async function findProjectDir(
  active?: vscode.Uri,
): Promise<vscode.Uri | undefined> {
  const startDirs: string[] = [];
  if (active?.scheme === "file") {
    startDirs.push(path.dirname(active.fsPath));
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    startDirs.push(folder.uri.fsPath);
  }

  for (const start of startDirs) {
    let dir = start;
    for (;;) {
      if (fs.existsSync(path.join(dir, PROJECT_MARKER))) {
        return vscode.Uri.file(dir);
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  // Nested project: search the workspace for a Project.m1prj below the open folder.
  const found = await vscode.workspace.findFiles(
    `**/${PROJECT_MARKER}`,
    "**/node_modules/**",
    1,
  );
  if (found.length > 0) {
    return vscode.Uri.file(path.dirname(found[0].fsPath));
  }

  return undefined;
}

function expand(p: string): string {
  let out = p;
  if (out.startsWith("~")) {
    out = path.join(os.homedir(), out.slice(1));
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) {
    out = out.replace(/\$\{workspaceFolder\}/g, folder);
  }
  return out;
}

function findOnPath(bin: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here, keep looking
    }
  }
  return undefined;
}
