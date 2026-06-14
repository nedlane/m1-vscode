import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { FileChangeType } from "vscode-languageclient/node";

import { clients } from "./lsp-client";
import { findProjectDir, PROJECT_MARKER, resolveBin } from "./utils";

const execFileAsync = promisify(execFile);

// ---- m1-project: editor-driven Project.m1prj mutations (#85, #86) -----------

const PROJECT_BIN =
  process.platform === "win32" ? "m1-project.exe" : "m1-project";

let output: vscode.OutputChannel;

/** Wire the project commands to the extension's shared output channel, and
 * register the `m1-project` validate DiagnosticCollection on the extension's
 * lifecycle. Creating it eagerly here (rather than lazily on first validate)
 * binds its lifetime to `context.subscriptions`, so deactivate disposes it and
 * it cannot leak across an extension-host reload. */
export function initProjectCommands(
  sharedOutput: vscode.OutputChannel,
  context: vscode.ExtensionContext,
): void {
  output = sharedOutput;
  context.subscriptions.push(
    (validateDiagnostics =
      vscode.languages.createDiagnosticCollection("m1-project")),
  );
}

/**
 * Resolve the `m1-project` binary: the `m1.project.path` setting, then a bundled
 * copy under the extension's `server/` dir, then `m1-project` on PATH.
 */
function resolveProjectBin(
  context: vscode.ExtensionContext,
): string | undefined {
  return resolveBin(context, "project.path", PROJECT_BIN, (line) =>
    output.appendLine(line),
  );
}

/** The `Project.m1prj` path for the active editor's project, or the first server's root. */
async function activeProjectFile(): Promise<string | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const root =
    (active ? (await findProjectDir(active))?.fsPath : undefined) ??
    [...clients.values()].find((c) => c.root)?.root;
  return root ? path.join(root, PROJECT_MARKER) : undefined;
}

/** Run an m1-project subcommand against `projectFile`; resolves on success. */
async function runProject(
  context: vscode.ExtensionContext,
  args: string[],
): Promise<string> {
  return (await runProjectFull(context, args)).stdout;
}

/** Like `runProject` but also returns stderr (rename's backing-file warnings). */
async function runProjectFull(
  context: vscode.ExtensionContext,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const bin = resolveProjectBin(context);
  if (!bin) {
    throw new Error(
      "m1-project binary not found. Set 'm1.project.path', bundle it under server/, or put 'm1-project' on PATH.",
    );
  }
  const { stdout, stderr } = await execFileAsync(bin, args);
  return { stdout, stderr };
}

/**
 * Tell the language server(s) that an edited `Project.m1prj` changed, so each
 * reloads its project from disk — without the heavyweight stop+restart cycle.
 * m1-lsp reloads its project on a `workspace/didChangeWatchedFiles` Changed
 * event for the .m1prj (the Neovim client already relies on this). A full
 * restart is reserved for the explicit `m1.restartServer` command.
 */
function reloadProjectClients(projectFile: string): void {
  const uri = vscode.Uri.file(projectFile).toString();
  for (const { client } of clients.values()) {
    void client.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri, type: FileChangeType.Changed }],
    });
  }
}

/**
 * Shared guard + error handling for the m1-project commands: find the active
 * `Project.m1prj` (or surface an error and bail), run `fn` with it, send the
 * lightweight reload, and funnel any failure to a single error toast. `fn`
 * returns a success message to show, or undefined to stay silent (e.g. the user
 * cancelled a dialog).
 */
async function withProjectFile(
  actionName: string,
  fn: (projectFile: string) => Promise<string | undefined>,
): Promise<void> {
  try {
    const projectFile = await activeProjectFile();
    if (!projectFile || !fs.existsSync(projectFile)) {
      void vscode.window.showErrorMessage(
        "No Project.m1prj found for the active M1 project.",
      );
      return;
    }
    const message = await fn(projectFile);
    if (message === undefined) {
      return; // cancelled; no edit, no reload
    }
    reloadProjectClients(projectFile);
    if (message) {
      void vscode.window.showInformationMessage(message);
    }
  } catch (e) {
    void vscode.window.showErrorMessage(
      `${actionName} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function createChannel(context: vscode.ExtensionContext): Promise<void> {
  return withProjectFile("Create channel", async (projectFile) => {
    const name = await vscode.window.showInputBox({
      title: "Create M1 Channel",
      prompt: "Fully-qualified channel name (its parent group must exist)",
      placeHolder: "Root.Engine.NewSignal",
      validateInput: (v) =>
        /^Root\..+/.test(v.trim())
          ? undefined
          : "Name must be fully qualified, e.g. Root.Group.Name",
    });
    if (!name) {
      return undefined;
    }
    const type = await vscode.window.showQuickPick(
      ["(none)", "f32", "f64", "u8", "u16", "u32", "s8", "s16", "s32", "bool"],
      { title: "Storage type", placeHolder: "Channel storage type (optional)" },
    );
    if (type === undefined) {
      return undefined;
    }
    const unit = await vscode.window.showInputBox({
      title: "Unit (optional)",
      prompt: "Display unit, e.g. rpm — leave blank for none",
    });
    if (unit === undefined) {
      return undefined;
    }
    const security = await vscode.window.showQuickPick(
      ["(none)", "Tune", "Calibration", "Master Calibration", "Resource"],
      { title: "Security level (optional)" },
    );
    if (security === undefined) {
      return undefined;
    }
    const args = [
      "create-channel",
      "--project",
      projectFile,
      "--name",
      name.trim(),
    ];
    if (type !== "(none)") {
      args.push("--type", type);
    }
    if (unit.trim()) {
      args.push("--unit", unit.trim());
    }
    if (security !== "(none)") {
      args.push("--security", security);
    }
    await runProject(context, args);
    return `Created channel ${name.trim()}`;
  });
}

export function setChannelSecurity(
  context: vscode.ExtensionContext,
  preselected?: string,
): Promise<void> {
  return withProjectFile("Set security", async (projectFile) => {
    const component = await pickComponent(
      "Set Component Security",
      preselected,
    );
    if (!component) {
      return undefined;
    }
    const security = await vscode.window.showQuickPick(
      ["Tune", "Calibration", "Master Calibration", "Resource"],
      { title: "Security level" },
    );
    if (!security) {
      return undefined;
    }
    await runProject(context, [
      "set-security",
      "--project",
      projectFile,
      "--component",
      component,
      "--security",
      security,
    ]);
    return `${component} security → ${security}`;
  });
}

export function setCallRate(context: vscode.ExtensionContext): Promise<void> {
  return withProjectFile("Set call rate", async (projectFile) => {
    const script = await vscode.window.showInputBox({
      title: "Set Script Call Rate",
      prompt: "Fully-qualified script (FuncUser/MethodUser) name",
      placeHolder: "Root.Engine.Update",
      validateInput: (v) =>
        /^Root\..+/.test(v.trim()) ? undefined : "Name must be fully qualified",
    });
    if (!script) {
      return undefined;
    }
    // Offer the rates the project actually defines (its On <N>Hz clocks).
    let rates: string[] = [];
    try {
      const out = await runProject(context, [
        "list-rates",
        "--project",
        projectFile,
      ]);
      rates = out
        .split("\n")
        .map((r) => r.trim())
        .filter(Boolean);
    } catch {
      // fall through to a free-text entry below
    }
    const pick = await vscode.window.showQuickPick(
      rates.length ? rates : ["100Hz", "50Hz", "20Hz", "10Hz", "Startup"],
      { title: "Execution rate" },
    );
    if (!pick) {
      return undefined;
    }
    // The CLI wants `startup` or a bare number; strip the trailing "Hz".
    const rate = /startup/i.test(pick) ? "startup" : pick.replace(/Hz$/i, "");
    await runProject(context, [
      "set-call-rate",
      "--project",
      projectFile,
      "--script",
      script.trim(),
      "--rate",
      rate,
    ]);
    return `${script.trim()} call rate → ${pick}`;
  });
}

/** Prompt for a component unless the caller (e.g. the project tree) supplied one. */
async function pickComponent(
  title: string,
  preselected?: string,
): Promise<string | undefined> {
  if (preselected) {
    return preselected;
  }
  const component = await vscode.window.showInputBox({
    title,
    prompt: "Fully-qualified component name",
    placeHolder: "Root.Engine.Speed",
    validateInput: (v) =>
      /^Root\..+/.test(v.trim()) ? undefined : "Name must be fully qualified",
  });
  return component?.trim() || undefined;
}

/** The storage types m1-project's set-type accepts (plus enum references typed manually). */
const STORAGE_TYPES = [
  "f32",
  "f64",
  "u8",
  "u16",
  "u32",
  "s8",
  "s16",
  "s32",
  "bool",
];

/** `m1.setChannelType` (#72): set a component's storage type via m1-project. */
export function setChannelType(
  context: vscode.ExtensionContext,
  preselected?: string,
): Promise<void> {
  return withProjectFile("Set type", async (projectFile) => {
    const component = await pickComponent("Set Component Type", preselected);
    if (!component) {
      return undefined;
    }
    const type = await vscode.window.showQuickPick(STORAGE_TYPES, {
      title: "Storage type",
    });
    if (!type) {
      return undefined;
    }
    await runProject(context, [
      "set-type",
      "--project",
      projectFile,
      "--component",
      component,
      "--type",
      type,
    ]);
    return `${component} type → ${type}`;
  });
}

/** `m1.setChannelUnit` (#72): set a component's display unit via m1-project. */
export function setChannelUnit(
  context: vscode.ExtensionContext,
  preselected?: string,
): Promise<void> {
  return withProjectFile("Set unit", async (projectFile) => {
    const component = await pickComponent("Set Component Unit", preselected);
    if (!component) {
      return undefined;
    }
    const unit = await vscode.window.showInputBox({
      title: "Display unit",
      prompt: "e.g. rpm, kPa, °C",
    });
    if (!unit?.trim()) {
      return undefined;
    }
    await runProject(context, [
      "set-unit",
      "--project",
      projectFile,
      "--component",
      component,
      "--unit",
      unit.trim(),
    ]);
    return `${component} unit → ${unit.trim()}`;
  });
}

/** `m1.createGroup` (#81): add a BuiltIn.GroupCompound under an existing group. */
export function createGroup(
  context: vscode.ExtensionContext,
  preselectedParent?: string,
): Promise<void> {
  return withProjectFile("Create group", async (projectFile) => {
    const name = await vscode.window.showInputBox({
      title: "Create M1 Group",
      prompt: "Fully-qualified group name (its parent group must exist)",
      placeHolder: "Root.Engine.NewSubsystem",
      value: preselectedParent ? `${preselectedParent}.` : undefined,
      validateInput: (v) =>
        /^Root\..+/.test(v.trim())
          ? undefined
          : "Name must be fully qualified, e.g. Root.Group.Name",
    });
    if (!name) {
      return undefined;
    }
    await runProject(context, [
      "create-group",
      "--project",
      projectFile,
      "--name",
      name.trim(),
    ]);
    return `Created group ${name.trim()}`;
  });
}

/** `m1.deleteComponent` (#81): destructive — modal confirm, optional subtree. */
export function deleteComponent(
  context: vscode.ExtensionContext,
  preselected?: string,
): Promise<void> {
  return withProjectFile("Delete component", async (projectFile) => {
    const component = await pickComponent("Delete Component", preselected);
    if (!component) {
      return undefined;
    }
    const choice = await vscode.window.showWarningMessage(
      `Delete ${component} from the project?`,
      {
        modal: true,
        detail:
          "This edits Project.m1prj in place. \u201CDelete subtree\u201D also removes every child component.",
      },
      "Delete",
      "Delete subtree",
    );
    if (!choice) {
      return undefined;
    }
    const args = [
      "delete-component",
      "--project",
      projectFile,
      "--name",
      component,
    ];
    if (choice === "Delete subtree") {
      args.push("--recursive");
    }
    await runProject(context, args);
    return `Deleted ${component}`;
  });
}

/** `m1.renameComponent` (#81): rename + SelectedTrigger references; surfaces the
 * CLI's backing-script-filename guidance for group/function renames. */
export function renameComponent(
  context: vscode.ExtensionContext,
  preselected?: string,
): Promise<void> {
  return withProjectFile("Rename component", async (projectFile) => {
    const component = await pickComponent("Rename Component", preselected);
    if (!component) {
      return undefined;
    }
    const newName = await vscode.window.showInputBox({
      title: `Rename ${component}`,
      prompt: "New single-segment name (no dots)",
      value: component.split(".").pop(),
      validateInput: (v) =>
        v.trim() && !v.includes(".")
          ? undefined
          : "Single segment only (no dots) — the parent path stays unchanged",
    });
    if (!newName) {
      return undefined;
    }
    const { stderr } = await runProjectFull(context, [
      "rename-component",
      "--project",
      projectFile,
      "--name",
      component,
      "--new-name",
      newName.trim(),
    ]);
    // The CLI warns on stderr when backing .m1scr files follow the
    // path-encoding filename convention and may need renaming too.
    if (stderr.trim()) {
      output.appendLine(stderr.trim());
      void vscode.window.showWarningMessage(
        `Renamed ${component} \u2192 ${newName.trim()}. ${stderr.trim()}`,
      );
      return ""; // already toasted; suppress the info toast (but still reload)
    }
    return `Renamed ${component} \u2192 ${newName.trim()}`;
  });
}

/** Findings from `m1-project validate`, rendered into the Problems panel.
 * Created and registered for disposal in `initProjectCommands` so its lifetime
 * is owned by the extension (no leak on deactivate / extension-host reload). */
let validateDiagnostics: vscode.DiagnosticCollection | undefined;

/** `m1.validateProject` (#81): run the structural validation and load findings
 * (`ERROR path: msg` / `WARN path: msg`) into Problems against the .m1prj. */
export function validateProject(
  context: vscode.ExtensionContext,
): Promise<void> {
  return withProjectFile("Validate project", async (projectFile) => {
    let out: string;
    try {
      out = await runProject(context, ["validate", "--project", projectFile]);
    } catch (e) {
      // validate exits 1 on error-level findings; the report is still on stdout.
      // Guard: only recover stdout when the thrown value is an Error-like object
      // that carries a stdout property — a bare cast would silently yield
      // undefined for signals/timeouts and swallow the real error.
      if (!(e instanceof Error) || !("stdout" in e)) {
        throw e;
      }
      const stdout = (e as Error & { stdout: unknown }).stdout;
      if (typeof stdout !== "string" || !stdout) {
        throw e;
      }
      out = stdout;
    }
    const uri = vscode.Uri.file(projectFile);
    const findings: vscode.Diagnostic[] = [];
    for (const line of out.split("\n")) {
      const m = /^(ERROR|WARN) (.+)$/.exec(line.trim());
      if (!m) {
        continue;
      }
      const d = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 0),
        m[2],
        m[1] === "ERROR"
          ? vscode.DiagnosticSeverity.Error
          : vscode.DiagnosticSeverity.Warning,
      );
      d.source = "m1-project";
      findings.push(d);
    }
    // Always set on the extension-owned collection created in
    // initProjectCommands; the `?.` only guards the (unreachable in practice)
    // case of validate running before activation wired it up.
    validateDiagnostics?.set(uri, findings);
    const summary = out.trim().split("\n").pop() ?? "done";
    if (findings.length > 0) {
      void vscode.window.showWarningMessage(`Project validation: ${summary}`);
      return ""; // already toasted as a warning; no model change, but reload is harmless
    }
    return `Project validation: ${summary}`;
  });
}

/** One entry of `m1-project list-components --json` (#77/#78 data source). */
export interface ComponentEntry {
  path: string;
  classname: string;
  type: string | null;
  unit: string | null;
  security: string | null;
  call_rate: string | null;
}

/**
 * Run `m1-project list-components --json` against an explicit `projectFile` and
 * parse the payload into typed `ComponentEntry[]`. The single source of truth
 * for the list-components CLI invocation and parse — both the active-project
 * `listComponents()` and the axis-source `pickChannel()` go through here so the
 * argv and parse cannot drift apart.
 */
async function listComponentsFor(
  context: vscode.ExtensionContext,
  projectFile: string,
): Promise<ComponentEntry[]> {
  const out = await runProject(context, [
    "list-components",
    "--project",
    projectFile,
    "--json",
  ]);
  return JSON.parse(out) as ComponentEntry[];
}

/**
 * The project's component tree via `m1-project list-components --json` —
 * the shared data source for the Project Explorer tree (#77) and the
 * security-matrix webview (#78). Works without a running language server.
 */
export async function listComponents(
  context: vscode.ExtensionContext,
): Promise<{ projectFile: string; components: ComponentEntry[] } | undefined> {
  const projectFile = await activeProjectFile();
  if (!projectFile || !fs.existsSync(projectFile)) {
    return undefined;
  }
  return {
    projectFile,
    components: await listComponentsFor(context, projectFile),
  };
}

/** Shared shape of the simple `set-<x> --component --<flag> <value>` verbs. */
async function setComponentValue(
  context: vscode.ExtensionContext,
  opts: {
    label: string;
    verb: string;
    flag: string;
    prompt: string;
    placeHolder?: string;
    preselected?: string;
  },
): Promise<void> {
  return withProjectFile(opts.label, async (projectFile) => {
    const component = await pickComponent(opts.label, opts.preselected);
    if (!component) {
      return undefined;
    }
    const value = await vscode.window.showInputBox({
      title: `${opts.label}: ${component}`,
      prompt: opts.prompt,
      placeHolder: opts.placeHolder,
    });
    if (!value?.trim()) {
      return undefined;
    }
    await runProject(context, [
      opts.verb,
      "--project",
      projectFile,
      "--component",
      component,
      opts.flag,
      value.trim(),
    ]);
    return `${component} ${opts.verb.replace("set-", "")} → ${value.trim()}`;
  });
}

/** `m1.setQuantity` (#92): a component's physical quantity. */
export function setQuantity(
  context: vscode.ExtensionContext,
  preselected?: string,
): Promise<void> {
  return setComponentValue(context, {
    label: "Set quantity",
    verb: "set-quantity",
    flag: "--quantity",
    prompt: "Physical quantity, e.g. Angular Speed",
    placeHolder: "Angular Speed",
    preselected,
  });
}

/** `m1.setFormat` (#92): a component's display format string. */
export function setFormat(
  context: vscode.ExtensionContext,
  preselected?: string,
): Promise<void> {
  return setComponentValue(context, {
    label: "Set format",
    verb: "set-format",
    flag: "--format",
    prompt: "Display format, e.g. %.1f",
    placeHolder: "%.1f",
    preselected,
  });
}

/** `m1.setDps` (#92): a component's display decimal places. */
export function setDps(
  context: vscode.ExtensionContext,
  preselected?: string,
): Promise<void> {
  return setComponentValue(context, {
    label: "Set decimal places",
    verb: "set-dps",
    flag: "--dps",
    prompt: "Display decimal places, e.g. 2",
    placeHolder: "2",
    preselected,
  });
}

/** `m1.addTag` / `m1.removeTag` (#92): the in-editor remedy for the T092
 * missing-System/Type-tag audit. */
export function addTag(
  context: vscode.ExtensionContext,
  preselected?: string,
): Promise<void> {
  return setComponentValue(context, {
    label: "Add tag",
    verb: "add-tag",
    flag: "--tag",
    prompt: "Tag to add (System/Type tag name)",
    preselected,
  });
}

export function removeTag(
  context: vscode.ExtensionContext,
  preselected?: string,
): Promise<void> {
  return setComponentValue(context, {
    label: "Remove tag",
    verb: "remove-tag",
    flag: "--tag",
    prompt: "Tag to remove",
    preselected,
  });
}

/** `m1.setValidation` (#92): MinMax bounds or clear — the in-editor remedy for
 * T043 parameter-outside-validation findings. */
export function setValidation(
  context: vscode.ExtensionContext,
  preselected?: string,
): Promise<void> {
  return withProjectFile("Set validation", async (projectFile) => {
    const component = await pickComponent("Set Validation", preselected);
    if (!component) {
      return undefined;
    }
    const kind = await vscode.window.showQuickPick(["MinMax", "None"], {
      title: `Validation for ${component}`,
    });
    if (!kind) {
      return undefined;
    }
    if (kind === "None") {
      await runProject(context, [
        "set-validation",
        "--project",
        projectFile,
        "--component",
        component,
        "--type",
        "None",
      ]);
      return `${component} validation cleared`;
    }
    const min = await vscode.window.showInputBox({
      title: `Validation minimum for ${component}`,
      prompt: "Lower bound",
    });
    if (!min?.trim()) {
      return undefined;
    }
    const max = await vscode.window.showInputBox({
      title: `Validation maximum for ${component}`,
      prompt: "Upper bound",
    });
    if (!max?.trim()) {
      return undefined;
    }
    await runProject(context, [
      "set-validation",
      "--project",
      projectFile,
      "--component",
      component,
      "--min",
      min.trim(),
      "--max",
      max.trim(),
    ]);
    return `${component} validation → [${min.trim()}, ${max.trim()}]`;
  });
}

/** `m1.setDisplayRange` (#92): a component's display min/max. */
export function setDisplayRange(
  context: vscode.ExtensionContext,
  preselected?: string,
): Promise<void> {
  return withProjectFile("Set display range", async (projectFile) => {
    const component = await pickComponent("Set Display Range", preselected);
    if (!component) {
      return undefined;
    }
    const min = await vscode.window.showInputBox({
      title: `Display minimum for ${component}`,
      prompt: "Display range lower bound",
    });
    if (!min?.trim()) {
      return undefined;
    }
    const max = await vscode.window.showInputBox({
      title: `Display maximum for ${component}`,
      prompt: "Display range upper bound",
    });
    if (!max?.trim()) {
      return undefined;
    }
    await runProject(context, [
      "set-display-range",
      "--project",
      projectFile,
      "--component",
      component,
      "--min",
      min.trim(),
      "--max",
      max.trim(),
    ]);
    return `${component} display range → [${min.trim()}, ${max.trim()}]`;
  });
}

/** `m1.createParameter` / `m1.createFunction` / `m1.createScheduledFunction`
 * (#92): the remaining create verbs. Parameters share the channel prompts;
 * functions need only the fully-qualified name. */
export function createParameter(
  context: vscode.ExtensionContext,
): Promise<void> {
  return withProjectFile("Create parameter", async (projectFile) => {
    const name = await vscode.window.showInputBox({
      title: "Create M1 Parameter",
      prompt: "Fully-qualified parameter name (its parent group must exist)",
      placeHolder: "Root.Engine.Gain",
      validateInput: (v) =>
        /^Root\..+/.test(v.trim())
          ? undefined
          : "Name must be fully qualified, e.g. Root.Group.Name",
    });
    if (!name) {
      return undefined;
    }
    const type = await vscode.window.showQuickPick(
      ["(none)", "f32", "f64", "u8", "u16", "u32", "s8", "s16", "s32", "bool"],
      {
        title: "Storage type",
        placeHolder: "Parameter storage type (optional)",
      },
    );
    if (type === undefined) {
      return undefined;
    }
    const unit = await vscode.window.showInputBox({
      title: "Unit (optional)",
      prompt: "Display unit, e.g. rpm — leave blank for none",
    });
    if (unit === undefined) {
      return undefined;
    }
    const security = await vscode.window.showQuickPick(
      ["(none)", "Tune", "Calibration", "Master Calibration", "Resource"],
      { title: "Security level (optional)" },
    );
    if (security === undefined) {
      return undefined;
    }
    const args = [
      "create-parameter",
      "--project",
      projectFile,
      "--name",
      name.trim(),
    ];
    if (type !== "(none)") {
      args.push("--type", type);
    }
    if (unit.trim()) {
      args.push("--unit", unit.trim());
    }
    if (security !== "(none)") {
      args.push("--security", security);
    }
    await runProject(context, args);
    return `Created parameter ${name.trim()}`;
  });
}

function createFunctionWith(
  context: vscode.ExtensionContext,
  verb: "create-function" | "create-scheduled-function",
  label: string,
): Promise<void> {
  return withProjectFile(label, async (projectFile) => {
    const name = await vscode.window.showInputBox({
      title: `${label} (M1)`,
      prompt: "Fully-qualified name (its parent group must exist)",
      placeHolder: "Root.Engine.Update",
      validateInput: (v) =>
        /^Root\..+/.test(v.trim())
          ? undefined
          : "Name must be fully qualified, e.g. Root.Group.Name",
    });
    if (!name) {
      return undefined;
    }
    await runProject(context, [
      verb,
      "--project",
      projectFile,
      "--name",
      name.trim(),
    ]);
    return `Created ${name.trim()}`;
  });
}

export function createFunction(
  context: vscode.ExtensionContext,
): Promise<void> {
  return createFunctionWith(context, "create-function", "Create function");
}

export function createScheduledFunction(
  context: vscode.ExtensionContext,
): Promise<void> {
  return createFunctionWith(
    context,
    "create-scheduled-function",
    "Create scheduled function",
  );
}

/** QuickPick over the project's channels (for table axis sources), falling
 * back to a free-text input box if list-components fails. */
async function pickChannel(
  context: vscode.ExtensionContext,
  projectFile: string,
  title: string,
  optional: boolean,
): Promise<string | undefined> {
  let paths: string[] = [];
  try {
    const entries = await listComponentsFor(context, projectFile);
    paths = entries
      .filter((e) => e.classname === "BuiltIn.Channel")
      .map((e) => e.path);
  } catch {
    // fall through to the input box
  }
  if (paths.length === 0) {
    const typed = await vscode.window.showInputBox({
      title,
      prompt: "Axis source channel (fully-qualified)",
      placeHolder: "Root.Engine.Speed",
    });
    return typed?.trim() || undefined;
  }
  const items = optional ? ["(none — skip this axis)", ...paths] : paths;
  const picked = await vscode.window.showQuickPick(items, { title });
  if (picked === undefined) {
    return undefined;
  }
  return picked.startsWith("(none") ? "" : picked;
}

/** `m1.createConstant` (#98): add a BuiltIn.Constant with its literal Value. */
export function createConstant(
  context: vscode.ExtensionContext,
  preselectedParent?: string,
): Promise<void> {
  return withProjectFile("Create constant", async (projectFile) => {
    const name = await vscode.window.showInputBox({
      title: "Create M1 Constant",
      prompt: "Fully-qualified constant name (its parent group must exist)",
      placeHolder: "Root.CAN.Bus Select",
      value: preselectedParent ? `${preselectedParent}.` : undefined,
      validateInput: (v) =>
        /^Root\..+/.test(v.trim())
          ? undefined
          : "Name must be fully qualified, e.g. Root.Group.Name",
    });
    if (!name) {
      return undefined;
    }
    const value = await vscode.window.showInputBox({
      title: "Constant value",
      prompt: "The literal Value M1-Build shows (e.g. CAN Bus 1, 4096)",
      validateInput: (v) => (v.trim() ? undefined : "Value must not be empty"),
    });
    if (!value) {
      return undefined;
    }
    await runProject(context, [
      "create-constant",
      "--project",
      projectFile,
      "--name",
      name.trim(),
      "--value",
      value.trim(),
    ]);
    return `Created constant ${name.trim()}`;
  });
}

/** `m1.createTable` (#98): add a BuiltIn.Table with 1–3 axes; axis sources are
 * picked from the project's channels and validated/relativized by m1-project. */
export function createTable(
  context: vscode.ExtensionContext,
  preselectedParent?: string,
): Promise<void> {
  return withProjectFile("Create table", async (projectFile) => {
    const name = await vscode.window.showInputBox({
      title: "Create M1 Table",
      prompt: "Fully-qualified table name (its parent group must exist)",
      placeHolder: "Root.Engine.Torque Map",
      value: preselectedParent ? `${preselectedParent}.` : undefined,
      validateInput: (v) =>
        /^Root\..+/.test(v.trim())
          ? undefined
          : "Name must be fully qualified, e.g. Root.Group.Name",
    });
    if (!name) {
      return undefined;
    }
    const axisX = await pickChannel(
      context,
      projectFile,
      "X-axis source channel",
      false,
    );
    if (!axisX) {
      return undefined;
    }
    const xSites = await vscode.window.showInputBox({
      title: "X-axis sites (optional)",
      prompt: "Maximum X-axis breakpoints — leave blank for the default",
      validateInput: (v) =>
        !v.trim() || /^\d+$/.test(v.trim()) ? undefined : "Enter a number",
    });
    if (xSites === undefined) {
      return undefined;
    }
    const args = [
      "create-table",
      "--project",
      projectFile,
      "--name",
      name.trim(),
      "--axis-x",
      axisX,
    ];
    if (xSites.trim()) {
      args.push("--x-sites", xSites.trim());
    }
    const axisY = await pickChannel(
      context,
      projectFile,
      "Y-axis source channel (optional)",
      true,
    );
    if (axisY === undefined) {
      return undefined;
    }
    if (axisY) {
      args.push("--axis-y", axisY);
      const ySites = await vscode.window.showInputBox({
        title: "Y-axis sites (optional)",
        prompt: "Maximum Y-axis breakpoints — leave blank for the default",
        validateInput: (v) =>
          !v.trim() || /^\d+$/.test(v.trim()) ? undefined : "Enter a number",
      });
      if (ySites === undefined) {
        return undefined;
      }
      if (ySites.trim()) {
        args.push("--y-sites", ySites.trim());
      }
      const axisZ = await pickChannel(
        context,
        projectFile,
        "Z-axis source channel (optional)",
        true,
      );
      if (axisZ === undefined) {
        return undefined;
      }
      if (axisZ) {
        args.push("--axis-z", axisZ);
      }
    }
    const security = await vscode.window.showQuickPick(
      ["(none)", "Tune", "Calibration", "Master Calibration", "Resource"],
      { title: "Security level (optional)" },
    );
    if (security === undefined) {
      return undefined;
    }
    if (security !== "(none)") {
      args.push("--security", security);
    }
    await runProject(context, args);
    return `Created table ${name.trim()}`;
  });
}
