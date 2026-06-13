// M1 task provider (#75): "m1: lint" / "m1: fmt check" tasks over the
// workspace's scripts, with a problem matcher feeding the Problems panel —
// CI-parity runs that work even when the language server is down.
import * as vscode from "vscode";

import { resolveBin } from "./utils";

interface M1TaskDefinition extends vscode.TaskDefinition {
  type: "m1";
  tool: "lint" | "fmt";
}

function makeTask(
  context: vscode.ExtensionContext,
  scope: vscode.WorkspaceFolder,
  tool: "lint" | "fmt",
  output: (line: string) => void,
): vscode.Task | undefined {
  const binName =
    process.platform === "win32" ? `m1-${tool}.exe` : `m1-${tool}`;
  const bin = resolveBin(context, `${tool}.path`, binName, output) ?? binName;
  const def: M1TaskDefinition = { type: "m1", tool };
  // Both tools accept file lists; let the shell expand the glob.
  const command =
    tool === "lint"
      ? `find . -name '*.m1scr' -print0 | xargs -0 -r '${bin}'`
      : `find . -name '*.m1scr' -print0 | xargs -0 -r '${bin}' --check`;
  const task = new vscode.Task(
    def,
    scope,
    tool === "lint" ? "lint" : "fmt check",
    "m1",
    new vscode.ShellExecution(command),
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
