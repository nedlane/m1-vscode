// M1 Project Explorer (#77): the Project.m1prj group/channel hierarchy as a
// TreeView, fed by `m1-project list-components --json` so it works with or
// without a running language server. Context-menu actions reuse the
// m1-project commands with the node's path pre-selected.
import * as vscode from "vscode";

import { ComponentEntry, listComponents } from "./project-commands";

class ComponentNode extends vscode.TreeItem {
  constructor(
    public readonly path: string,
    public readonly entry: ComponentEntry | undefined,
    hasChildren: boolean,
  ) {
    super(
      path.split(".").pop() ?? path,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    const cls = entry?.classname ?? "";
    const props: string[] = [];
    if (entry?.type) {
      props.push(entry.type);
    }
    if (entry?.unit) {
      props.push(entry.unit);
    }
    if (entry?.security) {
      props.push(`🔒 ${entry.security}`);
    }
    this.description = props.join(" · ");
    this.tooltip = `${path}\n${cls}`;
    // Drives the context-menu `when` clauses in package.json.
    this.contextValue = cls.includes("Channel")
      ? "m1Channel"
      : cls.includes("Parameter")
        ? "m1Parameter"
        : cls.includes("GroupCompound")
          ? "m1Group"
          : "m1Component";
    this.iconPath = new vscode.ThemeIcon(
      cls.includes("GroupCompound")
        ? "symbol-namespace"
        : cls.includes("Func") || cls.includes("Method")
          ? "symbol-method"
          : cls.includes("Parameter")
            ? "symbol-property"
            : "symbol-variable",
    );
  }
}

export class ProjectTreeProvider implements vscode.TreeDataProvider<ComponentNode> {
  private readonly emitter = new vscode.EventEmitter<
    ComponentNode | undefined
  >();
  readonly onDidChangeTreeData = this.emitter.event;

  /** path → entry, plus a child index by parent path. */
  private byPath = new Map<string, ComponentEntry>();
  private children = new Map<string, Set<string>>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this.byPath.clear();
    this.children.clear();
    this.emitter.fire(undefined);
  }

  private async load(): Promise<void> {
    if (this.byPath.size > 0) {
      return;
    }
    const result = await listComponents(this.context).catch(() => undefined);
    if (!result) {
      return;
    }
    for (const entry of result.components) {
      this.byPath.set(entry.path, entry);
      const parent = entry.path.includes(".")
        ? entry.path.slice(0, entry.path.lastIndexOf("."))
        : "";
      if (!this.children.has(parent)) {
        this.children.set(parent, new Set());
      }
      this.children.get(parent)?.add(entry.path);
    }
  }

  getTreeItem(node: ComponentNode): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: ComponentNode): Promise<ComponentNode[]> {
    await this.load();
    const parent = node?.path ?? "";
    const kids = [...(this.children.get(parent) ?? [])].sort();
    // The synthetic top level holds `Root` (and any stray top-level names).
    return kids.map(
      (p) => new ComponentNode(p, this.byPath.get(p), this.children.has(p)),
    );
  }
}

/** Register the view + its refresh / context-menu commands. */
export function registerProjectTree(
  context: vscode.ExtensionContext,
  commands: {
    setType: (c: vscode.ExtensionContext, sel?: string) => Promise<void>;
    setUnit: (c: vscode.ExtensionContext, sel?: string) => Promise<void>;
    setSecurity: (c: vscode.ExtensionContext, sel?: string) => Promise<void>;
    createGroup: (c: vscode.ExtensionContext, sel?: string) => Promise<void>;
    createConstant: (c: vscode.ExtensionContext, sel?: string) => Promise<void>;
    createTable: (c: vscode.ExtensionContext, sel?: string) => Promise<void>;
    deleteComponent: (
      c: vscode.ExtensionContext,
      sel?: string,
    ) => Promise<void>;
    renameComponent: (
      c: vscode.ExtensionContext,
      sel?: string,
    ) => Promise<void>;
    setValidation: (c: vscode.ExtensionContext, sel?: string) => Promise<void>;
    setQuantity: (c: vscode.ExtensionContext, sel?: string) => Promise<void>;
    setFormat: (c: vscode.ExtensionContext, sel?: string) => Promise<void>;
    setDps: (c: vscode.ExtensionContext, sel?: string) => Promise<void>;
    setDisplayRange: (
      c: vscode.ExtensionContext,
      sel?: string,
    ) => Promise<void>;
    addTag: (c: vscode.ExtensionContext, sel?: string) => Promise<void>;
    removeTag: (c: vscode.ExtensionContext, sel?: string) => Promise<void>;
  },
): void {
  const provider = new ProjectTreeProvider(context);

  // The node-action context-menu commands are all the identical shape:
  // run a commands.* verb with the node's path pre-selected, then refresh the
  // tree. Table-drive them so a new action is one row, not a copy-pasted
  // wrapper (which risks a wrong-function or missing-refresh slip).
  //   #92 set* verbs · #81 createGroup/rename/delete · #98 createConstant/Table
  const treeActions: ReadonlyArray<
    [string, (c: vscode.ExtensionContext, sel?: string) => Promise<void>]
  > = [
    ["m1.projectTree.setType", commands.setType],
    ["m1.projectTree.setUnit", commands.setUnit],
    ["m1.projectTree.setValidation", commands.setValidation],
    ["m1.projectTree.setQuantity", commands.setQuantity],
    ["m1.projectTree.setFormat", commands.setFormat],
    ["m1.projectTree.setDps", commands.setDps],
    ["m1.projectTree.setDisplayRange", commands.setDisplayRange],
    ["m1.projectTree.addTag", commands.addTag],
    ["m1.projectTree.removeTag", commands.removeTag],
    ["m1.projectTree.setSecurity", commands.setSecurity],
    ["m1.projectTree.createGroup", commands.createGroup],
    ["m1.projectTree.createConstant", commands.createConstant],
    ["m1.projectTree.createTable", commands.createTable],
    ["m1.projectTree.rename", commands.renameComponent],
    ["m1.projectTree.delete", commands.deleteComponent],
  ];

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("m1ProjectExplorer", provider),
    // refresh has no node arg and a different body, so keep it explicit.
    vscode.commands.registerCommand("m1.projectTree.refresh", () =>
      provider.refresh(),
    ),
    ...treeActions.map(([id, fn]) =>
      vscode.commands.registerCommand(id, async (node: ComponentNode) => {
        await fn(context, node?.path);
        provider.refresh();
      }),
    ),
  );
}
