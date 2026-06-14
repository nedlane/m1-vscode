import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";

import {
  clients,
  describeClients,
  initLspClient,
  resolveServerPath,
  stopAllClients,
  syncClients,
} from "./lsp-client";
import {
  affectsM1Settings,
  pushSettingsToClients,
  DID_CHANGE_CONFIGURATION,
} from "./settings-sync";
import {
  addTag,
  createChannel,
  createConstant,
  createFunction,
  createGroup,
  createParameter,
  createScheduledFunction,
  createTable,
  deleteComponent,
  initProjectCommands,
  removeTag,
  renameComponent,
  setCallRate,
  setChannelSecurity,
  setChannelType,
  setChannelUnit,
  setDisplayRange,
  setDps,
  setFormat,
  setQuantity,
  setValidation,
  validateProject,
} from "./project-commands";
import { registerProjectTree } from "./project-tree";
import { showSecurityMatrix } from "./security-matrix";
import { refreshStatusBar, registerStatusBar } from "./status-bar";
import { registerTaskProvider } from "./tasks";
import { findProjectDir } from "./utils";

const execFileAsync = promisify(execFile);

let output: vscode.LogOutputChannel;

/**
 * A scoped client's root plus the shape of its document-selector anchor, used
 * by the multi-root integration test to assert each per-root server is anchored
 * to its own root (a relative pattern whose baseUri == root) rather than
 * over-claiming every `.m1scr` via a bare glob string.
 */
export interface ScopedClientInfo {
  /** The project root this client is scoped to. */
  root: string;
  /**
   * The document-selector entry's `pattern` is an anchored relative pattern
   * (`{ baseUri, pattern }`). `false` means it was a bare glob string, which
   * silently over-claims the whole workspace.
   */
  patternIsRelative: boolean;
  /**
   * The `fsPath` of the anchoring relative pattern's `baseUri`, when present.
   * Compared against the client's own root to confirm the anchor is correct.
   */
  patternBase: string | undefined;
}

/** The API `activate()` returns as `extension.exports` — a small seam the
 * integration tests use to exercise the live-settings propagation (#120) and
 * scoped-client anchoring (#20) without reaching into module internals. */
export interface M1ExtensionApi {
  affectsM1Settings: typeof affectsM1Settings;
  pushSettingsToClients: typeof pushSettingsToClients;
  didChangeConfigurationMethod: string;
  /** Snapshot the running scoped (multi-root) clients' selector anchoring. */
  scopedClientInfo(): ScopedClientInfo[];
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<M1ExtensionApi> {
  // A log channel (not a plain one): vscode-languageclient ≥10 requires
  // LogOutputChannel for clientOptions.outputChannel.
  output = vscode.window.createOutputChannel("M1 Language Server", {
    log: true,
  });
  context.subscriptions.push(output);

  initLspClient(output, buildSettings);
  initProjectCommands(output, context);

  // #73 / #75 / #77: status bar, task provider, project explorer — registered
  // once on activation so they are present immediately without requiring the
  // user to run "Restart Language Server" first.
  registerStatusBar(context);
  registerTaskProvider(context, (line) => output.appendLine(line));
  registerProjectTree(context, {
    setType: setChannelType,
    setUnit: setChannelUnit,
    setSecurity: setChannelSecurity,
    createGroup,
    createConstant,
    createTable,
    deleteComponent,
    renameComponent,
    setValidation,
    setQuantity,
    setFormat,
    setDps,
    setDisplayRange,
    addTag,
    removeTag,
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("m1.showOutput", () => output.show()),
    // Full stop+restart is reserved for this explicit command; project edits use
    // a lighter workspace/didChangeWatchedFiles reload (see project-commands.ts).
    // The UI components (status bar, task provider, project explorer) are
    // registered once at activation above and persist across server restarts.
    vscode.commands.registerCommand("m1.restartServer", async () => {
      await stopAllClients();
      await syncClients(context);
      refreshStatusBar();
    }),
    vscode.commands.registerCommand("m1.showDiagnosticInfo", () =>
      showDiagnosticInfo(context),
    ),
    vscode.commands.registerCommand("m1.generateConfig", () =>
      generateConfig(context),
    ),
    vscode.commands.registerCommand("m1.createChannel", () =>
      createChannel(context),
    ),
    vscode.commands.registerCommand("m1.setChannelSecurity", () =>
      setChannelSecurity(context),
    ),
    vscode.commands.registerCommand("m1.setCallRate", () =>
      setCallRate(context),
    ),
    // #72: the last two m1-project subcommands get first-class commands.
    vscode.commands.registerCommand("m1.setChannelType", () =>
      setChannelType(context),
    ),
    vscode.commands.registerCommand("m1.setChannelUnit", () =>
      setChannelUnit(context),
    ),
    // #81: the m1-project v0.3.0 verbs — create-group / delete-component /
    // rename-component / validate.
    vscode.commands.registerCommand("m1.createGroup", () =>
      createGroup(context),
    ),
    vscode.commands.registerCommand("m1.deleteComponent", () =>
      deleteComponent(context),
    ),
    vscode.commands.registerCommand("m1.renameComponent", () =>
      renameComponent(context),
    ),
    vscode.commands.registerCommand("m1.validateProject", () =>
      validateProject(context),
    ),
    // #92: the remaining m1-project v0.4.0 verbs.
    vscode.commands.registerCommand("m1.createParameter", () =>
      createParameter(context),
    ),
    vscode.commands.registerCommand("m1.createConstant", () =>
      createConstant(context),
    ),
    vscode.commands.registerCommand("m1.createTable", () =>
      createTable(context),
    ),
    vscode.commands.registerCommand("m1.createFunction", () =>
      createFunction(context),
    ),
    vscode.commands.registerCommand("m1.createScheduledFunction", () =>
      createScheduledFunction(context),
    ),
    vscode.commands.registerCommand("m1.setValidation", (c?: string) =>
      setValidation(context, c),
    ),
    vscode.commands.registerCommand("m1.setQuantity", (c?: string) =>
      setQuantity(context, c),
    ),
    vscode.commands.registerCommand("m1.setFormat", (c?: string) =>
      setFormat(context, c),
    ),
    vscode.commands.registerCommand("m1.setDps", (c?: string) =>
      setDps(context, c),
    ),
    vscode.commands.registerCommand("m1.setDisplayRange", (c?: string) =>
      setDisplayRange(context, c),
    ),
    vscode.commands.registerCommand("m1.addTag", (c?: string) =>
      addTag(context, c),
    ),
    vscode.commands.registerCommand("m1.removeTag", (c?: string) =>
      removeTag(context, c),
    ),
    // #78: channels × access level audit table.
    vscode.commands.registerCommand("m1.showSecurityMatrix", () =>
      showSecurityMatrix(context),
    ),
    // Target of the clickable execution-rate code lens (#175): jump to a 0-based
    // line in a file (the script's SelectedTrigger declaration in Project.m1prj).
    // Registered client-side so it works without the server advertising
    // executeCommandProvider — which collided across the per-root clients.
    vscode.commands.registerCommand(
      "m1.revealLocation",
      async (uri: string, line: number) => {
        const doc = await vscode.workspace.openTextDocument(
          vscode.Uri.parse(uri),
        );
        const editor = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(Math.max(0, line), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.InCenter,
        );
      },
    ),
    // Push edited m1.* settings to every running server live (the middle config
    // layer beneath a workspace m1-tools.toml).
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (affectsM1Settings(e)) {
        pushSettingsToClients(clients.values(), buildSettings());
      }
    }),
    // Add/remove servers as project folders enter or leave the workspace.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void syncClients(context);
    }),
  );

  await syncClients(context);

  return {
    affectsM1Settings,
    pushSettingsToClients,
    didChangeConfigurationMethod: DID_CHANGE_CONFIGURATION,
    scopedClientInfo: () =>
      [...clients.values()]
        .filter((c) => c.root !== undefined)
        .map((c) => {
          const filter = c.documentSelector[0];
          const pattern =
            filter && typeof filter === "object" && "pattern" in filter
              ? (filter as { pattern?: unknown }).pattern
              : undefined;
          // The anchored form is the LSP relative pattern { baseUri, pattern };
          // a bare glob string is not anchored and over-claims the workspace.
          const isRelative =
            typeof pattern === "object" &&
            pattern !== null &&
            typeof (pattern as { baseUri?: unknown }).baseUri === "string";
          return {
            root: c.root as string,
            patternIsRelative: isRelative,
            patternBase: isRelative
              ? vscode.Uri.parse((pattern as { baseUri: string }).baseUri)
                  .fsPath
              : undefined,
          };
        }),
  };
}

export async function deactivate(): Promise<void> {
  await stopAllClients();
}

/**
 * Open a tab summarising the extension's current state — versions, the resolved
 * server path, client status, the active project, and the server capabilities
 * from the initialize response. Helps users verify their setup and file bugs.
 */
async function showDiagnosticInfo(
  context: vscode.ExtensionContext,
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content: describeClients(context),
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
  // [vsCodeSection.vsCodeKey, tomlSection, tomlKey] — one entry per contributed
  // m1.lint/m1.format/m1.diagnostics setting; test/settings-surface.mjs fails
  // if this map and contributes.configuration drift apart (#106).
  const map: [string, "lint" | "format" | "diagnostics", string][] = [
    ["lint.maxLineLength", "lint", "max_line_length"],
    ["lint.maxNestingDepth", "lint", "max_nesting_depth"],
    ["lint.maxComplexity", "lint", "max_complexity"],
    ["lint.maxCognitiveComplexity", "lint", "max_cognitive_complexity"],
    ["lint.exclude", "lint", "exclude"],
    ["format.lineWidth", "format", "line_width"],
    ["format.maxBlankLines", "format", "max_blank_lines"],
    ["format.indentStyle", "format", "indent_style"],
    ["format.indentWidth", "format", "indent_width"],
    ["format.braceStyle", "format", "brace_style"],
    ["format.continuationIndent", "format", "continuation_indent"],
    ["format.alignAssignments", "format", "align_assignments"],
    ["format.reflowComments", "format", "reflow_comments"],
    ["diagnostics.ignore", "diagnostics", "ignore"],
    ["diagnostics.select", "diagnostics", "select"],
    ["diagnostics.ignoreSymbols", "diagnostics", "ignore_symbols"],
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
  // Prefer the project root of the active .m1scr, then the only/first running
  // server's root, then the first workspace folder.
  const active = vscode.window.activeTextEditor?.document.uri;
  const activeRoot = active
    ? (await findProjectDir(active))?.fsPath
    : undefined;
  const firstClientRoot = [...clients.values()].find((c) => c.root)?.root;
  const root =
    activeRoot ??
    firstClientRoot ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
