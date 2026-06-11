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
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("m1ProjectExplorer", provider),
    vscode.commands.registerCommand("m1.projectTree.refresh", () =>
      provider.refresh(),
    ),
    vscode.commands.registerCommand(
      "m1.projectTree.setType",
      async (node: ComponentNode) => {
        await commands.setType(context, node?.path);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "m1.projectTree.setUnit",
      async (node: ComponentNode) => {
        await commands.setUnit(context, node?.path);
        provider.refresh();
      },
    ),
    // #92: the remaining m1-project v0.4.0 verbs on tree nodes.
    vscode.commands.registerCommand(
      "m1.projectTree.setValidation",
      async (node: ComponentNode) => {
        await commands.setValidation(context, node?.path);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "m1.projectTree.setQuantity",
      async (node: ComponentNode) => {
        await commands.setQuantity(context, node?.path);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "m1.projectTree.setFormat",
      async (node: ComponentNode) => {
        await commands.setFormat(context, node?.path);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "m1.projectTree.setDps",
      async (node: ComponentNode) => {
        await commands.setDps(context, node?.path);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "m1.projectTree.setDisplayRange",
      async (node: ComponentNode) => {
        await commands.setDisplayRange(context, node?.path);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "m1.projectTree.addTag",
      async (node: ComponentNode) => {
        await commands.addTag(context, node?.path);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "m1.projectTree.removeTag",
      async (node: ComponentNode) => {
        await commands.removeTag(context, node?.path);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "m1.projectTree.setSecurity",
      async (node: ComponentNode) => {
        await commands.setSecurity(context, node?.path);
        provider.refresh();
      },
    ),
    // #81: structural actions — Create Group on groups, Rename/Delete on
    // every component node.
    vscode.commands.registerCommand(
      "m1.projectTree.createGroup",
      async (node: ComponentNode) => {
        await commands.createGroup(context, node?.path);
        provider.refresh();
      },
    ),
    // #98: the m1-project v0.6.0 create verbs on group nodes.
    vscode.commands.registerCommand(
      "m1.projectTree.createConstant",
      async (node: ComponentNode) => {
        await commands.createConstant(context, node?.path);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "m1.projectTree.createTable",
      async (node: ComponentNode) => {
        await commands.createTable(context, node?.path);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "m1.projectTree.rename",
      async (node: ComponentNode) => {
        await commands.renameComponent(context, node?.path);
        provider.refresh();
      },
    ),
    vscode.commands.registerCommand(
      "m1.projectTree.delete",
      async (node: ComponentNode) => {
        await commands.deleteComponent(context, node?.path);
        provider.refresh();
      },
    ),
  );
}
