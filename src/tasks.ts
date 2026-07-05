// M1 task provider (#75): "m1: lint" / "m1: fmt check" tasks over the
// workspace's scripts, with a problem matcher feeding the Problems panel —
// CI-parity runs that work even when the language server is down.
import * as vscode from "vscode";

import { resolveBin } from "./utils";

interface M1TaskDefinition extends vscode.TaskDefinition {
  type: "m1";
  tool: "lint" | "fmt";
}

// Tools we've already warned about this session, so listing tasks (which builds
// them repeatedly) surfaces the "not found" guidance once, not on every refresh.
const warnedMissing = new Set<"lint" | "fmt">();

/** Point the user at the escape-hatch setting when a tool binary is missing. */
function warnMissingTool(tool: "lint" | "fmt"): void {
  if (warnedMissing.has(tool)) {
    return;
  }
  warnedMissing.add(tool);
  const setting = `m1.${tool}.path`;
  void vscode.window
    .showErrorMessage(
      `m1-${tool} not found — the "m1: ${tool === "lint" ? "lint" : "fmt check"}" task cannot run. ` +
        `Install the bundled VSIX, put m1-${tool} on your PATH, or set "${setting}".`,
      "Open Settings",
    )
    .then((choice) => {
      if (choice === "Open Settings") {
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          setting,
        );
      }
    });
}

function makeTask(
  context: vscode.ExtensionContext,
  scope: vscode.WorkspaceFolder,
  tool: "lint" | "fmt",
  output: (line: string) => void,
): vscode.Task | undefined {
  const binName =
    process.platform === "win32" ? `m1-${tool}.exe` : `m1-${tool}`;
  // Resolution order (shared with m1-lsp/m1-project via resolveBin): the
  // m1.<tool>.path setting, then the binary bundled under server/, then PATH.
  const resolved = resolveBin(context, `${tool}.path`, binName, output);
  if (!resolved) {
    warnMissingTool(tool);
  }
  const bin = resolved ?? binName;
  const def: M1TaskDefinition = { type: "m1", tool };
  // Spawn the binary directly (no shell): both CLIs recurse over a directory
  // argument (m1-lint `.`, m1-fmt `--check .`), so we hand them the workspace
  // folder and skip `find … | xargs` entirely. That shell pipeline is
  // POSIX-only and can never run on Windows (cmd.exe/PowerShell have no
  // `xargs` and a different `find`); ProcessExecution is platform-agnostic and
  // needs no quoting. cwd is the folder so the lint problem matcher's
  // relative-to-${workspaceFolder} paths resolve correctly.
  const args = tool === "lint" ? ["."] : ["--check", "."];
  const task = new vscode.Task(
    def,
    scope,
    tool === "lint" ? "lint" : "fmt check",
    "m1",
    new vscode.ProcessExecution(bin, args, { cwd: scope.uri.fsPath }),
    tool === "lint" ? ["$m1-lint"] : [],
  );
  task.group = tool === "lint" ? vscode.TaskGroup.Test : vscode.TaskGroup.Build;
  return task;
}

export function registerTaskProvider(
  context: vscode.ExtensionContext,
  output: (line: string) => void,
): void {
  context.subscriptions.push(
    vscode.tasks.registerTaskProvider("m1", {
      provideTasks(): vscode.Task[] {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          return [];
        }
        const tasks: vscode.Task[] = [];
        for (const folder of folders) {
          for (const tool of ["lint", "fmt"] as const) {
            const t = makeTask(context, folder, tool, output);
            if (t) {
              tasks.push(t);
            }
          }
        }
        return tasks;
      },
      resolveTask(task: vscode.Task): vscode.Task | undefined {
        const def = task.definition as M1TaskDefinition;
        if (def.tool !== "lint" && def.tool !== "fmt") {
          return undefined;
        }
        // Use the task's own scope when it is a WorkspaceFolder (the common
        // case for tasks loaded from tasks.json), otherwise fall back to the
        // first workspace folder so single-root behaviour is unchanged.
        // WorkspaceFolder is an interface (not a class) so we duck-type check
        // for its `uri` property rather than using instanceof.
        const scope = task.scope;
        const folder: vscode.WorkspaceFolder | undefined =
          scope !== undefined && typeof scope === "object" && "uri" in scope
            ? (scope as vscode.WorkspaceFolder)
            : vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
          return undefined;
        }
        return makeTask(context, folder, def.tool, output);
      },
    }),
  );
}
