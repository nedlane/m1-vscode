import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let output: vscode.OutputChannel;

const SERVER_BIN = process.platform === "win32" ? "m1-lsp.exe" : "m1-lsp";

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

  output.appendLine(`Starting m1-lsp: ${serverPath}`);

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
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.m1scr"),
    },
  };

  client = new LanguageClient(
    "m1-lsp",
    "M1 Language Server",
    serverOptions,
    clientOptions,
  );

  try {
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
    await client.stop().catch(() => undefined);
    client = undefined;
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
