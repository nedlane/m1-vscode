import * as path from "path";

/** Lexical containment, including the directory itself. */
export function containsPath(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function owningRoot(
  roots: readonly string[],
  file: string,
): string | undefined {
  return roots
    .filter((root) => containsPath(root, file))
    .sort((a, b) => b.length - a.length)[0];
}

interface Trie {
  terminal: boolean;
  children: Map<string, Trie>;
}

function node(): Trie {
  return { terminal: false, children: new Map() };
}

function insert(tree: Trie, parts: string[]): void {
  for (const part of parts) {
    if (!tree.children.has(part)) tree.children.set(part, node());
    tree = tree.children.get(part)!;
  }
  tree.terminal = true;
}

function literal(value: string): string {
  // VS Code's brace splitter needs a balanced outer group around a literal {.
  return value.replace(/[\[\]{}*?]/g, (c) => (c === "{" ? "{[{]}" : `[${c}]`));
}

/** Match one filename character outside a finite set, using VS Code globs. */
function differingCharacters(chars: Iterable<string>): string[] {
  const forbidden = new Set(chars);
  const excluded = new Set([...forbidden, "\\", "/"]);
  const extras = new Set([".", "0", "\\"]);
  // A literal slash is dropped inside a VS Code class. Exclude it by range,
  // then restore allowed endpoints. Brackets/braces need the same treatment.
  let inside = ".-0";
  for (const c of excluded) {
    if (c === "/") continue;
    if (c === "]") {
      inside += "\\-^";
      extras.add("^");
    } else if (c === "{") {
      inside += "z-|";
      extras.add("z");
      extras.add("|");
    } else if (c === "}") {
      inside += "|-~";
      extras.add("|");
      extras.add("~");
    } else if (c !== "-") inside += c;
  }
  if (excluded.has("-")) inside += "-";
  return [
    `[!${inside}]`,
    ...[...extras].filter((c) => !forbidden.has(c)).map(literal),
  ];
}

type NamePattern = { directory: string } | { pattern: string };

function otherNames(names: Iterable<string>): NamePattern[] {
  const tree = node();
  const out: NamePattern[] = [];
  // VS Code's glob regex matches UTF-16 code units, including surrogate pairs.
  for (const name of names) insert(tree, name.split(""));
  function walk(current: Trie, prefix: string): void {
    if (
      prefix &&
      prefix !== "." &&
      prefix !== ".." &&
      !/[\uD800-\uDBFF]$/.test(prefix) &&
      !current.terminal
    ) {
      out.push({ directory: prefix });
    }
    for (const char of differingCharacters(current.children.keys())) {
      out.push({ pattern: literal(prefix) + char + "*" });
    }
    for (const [char, child] of current.children) walk(child, prefix + char);
  }
  walk(tree, "");
  return out;
}

export interface OwnedPattern {
  base: string;
  pattern: string;
}

/** Positive relative patterns covering scripts outside the excluded subtrees.
 * VS Code document selectors have no exclusion operator. */
export function ownedPatterns(excludedRoots: string[][]): OwnedPattern[] {
  if (!excludedRoots.length) return [{ base: "", pattern: "**/*.m1scr" }];
  const tree = node();
  const out: OwnedPattern[] = [];
  for (const parts of excludedRoots) insert(tree, parts);
  function walk(current: Trie, parts: string[]): void {
    if (current.terminal) return;
    const base = path.join(...(parts.length ? parts : [""]));
    out.push({ base, pattern: "*.m1scr" });
    for (const name of otherNames(current.children.keys())) {
      // Anchor exact names with URIs: glob separators also match literal POSIX
      // backslashes, and could otherwise include an excluded sibling subtree.
      out.push(
        "directory" in name
          ? { base: path.join(base, name.directory), pattern: "**/*.m1scr" }
          : { base, pattern: name.pattern + "/**/*.m1scr" },
      );
    }
    for (const [name, child] of current.children) walk(child, [...parts, name]);
  }
  walk(tree, []);
  return out;
}
