import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";

/** The filename that marks the root of an M1 project. */
export const PROJECT_MARKER = "Project.m1prj";

/**
 * Walk up from `startDir` looking for a directory that contains `Project.m1prj`,
 * matching m1-lsp's own ancestor-only project discovery. Returns the directory
 * holding the marker, or undefined if none is found before reaching the
 * filesystem root.
 */
export function walkUpToProject(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, PROJECT_MARKER))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
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
export async function findProjectDir(
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
    const root = walkUpToProject(start);
    if (root) {
      return vscode.Uri.file(root);
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

/** Expand a leading `~` and `${workspaceFolder}` in a configured path. */
export function expand(p: string): string {
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

/** Find an executable named `bin` on the system PATH, or undefined. */
export function findOnPath(bin: string): string | undefined {
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

/**
 * Resolve a tool binary in priority order:
 *   1. The `m1.<settingKey>` setting (supports `~` and `${workspaceFolder}`).
 *   2. A binary bundled under the extension's `server/` directory.
 *   3. `binName` discovered on the system PATH.
 *
 * `log` (when given) receives a line if the configured path does not exist, so
 * the resolution can be traced in the relevant output channel.
 */
export function resolveBin(
  context: vscode.ExtensionContext,
  settingKey: string,
  binName: string,
  log?: (line: string) => void,
): string | undefined {
  const configured = vscode.workspace
    .getConfiguration("m1")
    .get<string>(settingKey);
  if (configured && configured.trim().length > 0) {
    const expanded = expand(configured.trim());
    if (fs.existsSync(expanded)) {
      return expanded;
    }
    log?.(`Configured m1.${settingKey} does not exist: ${expanded}`);
  }

  const bundled = context.asAbsolutePath(path.join("server", binName));
  if (fs.existsSync(bundled)) {
    return bundled;
  }

  return findOnPath(binName);
}
