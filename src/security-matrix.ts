// Security matrix webview (#78): channels/parameters × access level, grouped
// by top-level subsystem — the pre-competition audit view. Pairs with the
// per-script 🔒 code-lens badge the language server emits (m1-lsp#172).
import * as vscode from "vscode";

import { listComponents } from "./project-commands";

const LEVELS = ["Tune", "Calibration", "Master Calibration", "Resource"];

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function showSecurityMatrix(
  context: vscode.ExtensionContext,
): Promise<void> {
  const result = await listComponents(context).catch((e: unknown) => {
    void vscode.window.showErrorMessage(
      `Security matrix failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  });
  if (!result) {
    return;
  }
  const secured = result.components.filter((c) => c.security);
  const panel = vscode.window.createWebviewPanel(
    "m1SecurityMatrix",
    "M1 Security Matrix",
    vscode.ViewColumn.Active,
    { enableScripts: false },
  );

  // Group by the path's second segment (Root.<Subsystem>.…).
  const groups = new Map<string, typeof secured>();
  for (const c of secured) {
    const seg = c.path.split(".");
    const group = seg.length > 2 ? seg[1] : "(top level)";
    if (!groups.has(group)) {
      groups.set(group, []);
    }
    groups.get(group)?.push(c);
  }

  const colors: Record<string, string> = {
    Tune: "#2e7d32",
    Calibration: "#f9a825",
    "Master Calibration": "#ef6c00",
    Resource: "#c62828",
  };
  let rows = "";
  for (const [group, comps] of [...groups.entries()].sort()) {
    rows += `<tr class="group"><td colspan="${LEVELS.length + 1}">${esc(group)}</td></tr>`;
    for (const c of comps.sort((a, b) => a.path.localeCompare(b.path))) {
      const cells = LEVELS.map((l) =>
        c.security === l
          ? `<td class="hit" style="background:${colors[l]}">●</td>`
          : "<td></td>",
      ).join("");
      rows += `<tr><td class="path">${esc(c.path)}</td>${cells}</tr>`;
    }
  }
  const heads = LEVELS.map((l) => `<th>${esc(l)}</th>`).join("");
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 3px 8px; text-align: center; }
  td.path { text-align: left; font-family: var(--vscode-editor-font-family); }
  tr.group td { font-weight: bold; text-align: left; padding-top: 12px;
                border-bottom: 1px solid var(--vscode-editorWidget-border); }
  td.hit { color: white; border-radius: 4px; }
</style></head><body>
<h2>Security matrix — ${esc(String(secured.length))} secured component(s)</h2>
<table><tr><th style="text-align:left">Component</th>${heads}</tr>${rows}</table>
</body></html>`;
}
