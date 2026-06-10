// Status bar server indicator (#73): "M1 ⚡ <n>" when n language clients are
// running, "M1 ✗" when none is — click opens m1.showDiagnosticInfo. Refreshed
// on every client start/stop via notify().
import * as vscode from "vscode";

import { clients } from "./lsp-client";

let item: vscode.StatusBarItem | undefined;

export function registerStatusBar(context: vscode.ExtensionContext): void {
  item = vscode.window.createStatusBarItem(
    "m1.serverStatus",
    vscode.StatusBarAlignment.Right,
    90,
  );
  item.name = "M1 Language Server";
  item.command = "m1.showDiagnosticInfo";
  context.subscriptions.push(item);
  refreshStatusBar();
  // Only show for M1-ish editors, so the item doesn't clutter other work.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => refreshStatusBar()),
  );
}

export function refreshStatusBar(): void {
  if (!item) {
    return;
  }
  const active = vscode.window.activeTextEditor?.document.languageId;
  const relevant =
    active === "m1scr" || (active === undefined && clients.size > 0);
  if (!relevant && clients.size === 0) {
    item.hide();
    return;
  }
  if (clients.size > 0) {
    item.text = `M1 $(zap) ${clients.size > 1 ? clients.size : ""}`.trimEnd();
    item.tooltip = `m1-lsp running (${clients.size} client${clients.size > 1 ? "s" : ""}) — click for diagnostics`;
    item.backgroundColor = undefined;
  } else {
    item.text = "M1 $(x)";
    item.tooltip = "m1-lsp is not running — click for diagnostics";
    item.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
  }
  item.show();
}
