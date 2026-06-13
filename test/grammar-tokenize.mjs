// Verifies the TextMate grammar with the SAME engine VS Code uses
// (vscode-textmate + vscode-oniguruma). Tokenizes M1 snippets and asserts the
// expected scopes are assigned.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const vsctm = require("vscode-textmate");
const oniguruma = require("vscode-oniguruma");
const here = path.dirname(fileURLToPath(import.meta.url));
const grammarPath = path.join(here, "..", "syntaxes", "m1scr.tmLanguage.json");

const wasmBin = fs.readFileSync(
  require.resolve("vscode-oniguruma/release/onig.wasm"),
);
const vscodeOnigurumaLib = oniguruma.loadWASM(wasmBin).then(() => ({
  createOnigScanner: (sources) => new oniguruma.OnigScanner(sources),
  createOnigString: (s) => new oniguruma.OnigString(s),
}));

const registry = new vsctm.Registry({
  onigLib: vscodeOnigurumaLib,
  loadGrammar: async (scopeName) => {
    if (scopeName === "source.m1scr") {
      const content = fs.readFileSync(grammarPath, "utf8");
      return vsctm.parseRawGrammar(content, grammarPath);
    }
    return null;
  },
});

let pass = 0;
let fail = 0;
function expectScope(grammar, line, substr, scopeFragment) {
  const r = grammar.tokenizeLine(line, vsctm.INITIAL);
  const col = line.indexOf(substr);
  const tok = r.tokens.find((t) => col >= t.startIndex && col < t.endIndex);
  const scopes = tok ? tok.scopes : [];
  const ok = scopes.some((s) => s.includes(scopeFragment));
  if (ok) {
    console.log(`  PASS  "${substr}" -> ${scopeFragment}`);
    pass++;
  } else {
    console.log(
      `  FAIL  "${substr}" expected scope *${scopeFragment}*, got [${scopes.join(", ")}]`,
    );
    fail++;
  }
}

// Asserts the token covering `substr` (or its `occurrence`-th occurrence) does
// NOT carry a scope containing `scopeFragment`. Used for the relational-vs-type
// regression (#110): `<`/`>` comparisons must not be scoped as type annotations.
function refuteScope(grammar, line, substr, scopeFragment, occurrence = 0) {
  const r = grammar.tokenizeLine(line, vsctm.INITIAL);
  let col = -1;
  for (let i = 0; i <= occurrence; i++) {
    col = line.indexOf(substr, col + 1);
    if (col === -1) break;
  }
  const tok =
    col === -1
      ? undefined
      : r.tokens.find((t) => col >= t.startIndex && col < t.endIndex);
  const scopes = tok ? tok.scopes : [];
  const bad = scopes.some((s) => s.includes(scopeFragment));
  if (col !== -1 && !bad) {
    console.log(`  PASS  "${substr}" !-> ${scopeFragment}`);
    pass++;
  } else if (col === -1) {
    console.log(`  FAIL  "${substr}" not found in line`);
    fail++;
  } else {
    console.log(
      `  FAIL  "${substr}" must NOT be *${scopeFragment}*, got [${scopes.join(", ")}]`,
    );
    fail++;
  }
}

const grammar = await registry.loadGrammar("source.m1scr");
if (!grammar) {
  console.error("grammar failed to load");
  process.exit(1);
}

console.log("TextMate tokenization:");
expectScope(grammar, "local count = 0;", "local", "storage.modifier");
expectScope(grammar, "static foo = 1;", "static", "storage.modifier");
expectScope(grammar, "if (a) { } else { }", "if", "keyword.control");
expectScope(grammar, "when x is Idle { }", "is", "keyword.control");
expectScope(grammar, "expand i to 3 { }", "expand", "keyword.control.loop");
expectScope(grammar, "x = a and b;", "and", "keyword.operator.word");
expectScope(grammar, "x = a eq b;", "eq", "keyword.operator.word");
expectScope(grammar, "local flag = true;", "true", "constant.language.boolean");
expectScope(grammar, "local n = 42;", "42", "constant.numeric");
expectScope(grammar, "local f = 1.5;", "1.5", "constant.numeric.float");
expectScope(grammar, "local h = 0xFF;", "0xFF", "constant.numeric.hex");
expectScope(grammar, 'local s = "hi";', '"hi"', "string.quoted.double");
expectScope(grammar, "// a comment", "// a comment", "comment.line");
expectScope(
  grammar,
  "x = $(SEG) + 1;",
  "$(SEG)",
  "constant.other.interpolation",
);
expectScope(
  grammar,
  "local <Unsigned Integer> v = 1;",
  "Unsigned Integer",
  "entity.name.type",
);
// Every type-annotation form the corpus uses (a single identifier, which may
// contain spaces; M1 has no nested generics — see tree-sitter-m1 `type_annotation`).
expectScope(
  grammar,
  "local <Boolean> b = true;",
  "Boolean",
  "entity.name.type",
);
expectScope(
  grammar,
  "local <boolean> b = true;",
  "boolean",
  "entity.name.type",
);
expectScope(grammar, "local <Integer> i = 0;", "Integer", "entity.name.type");
expectScope(
  grammar,
  "local <Floating Point> f = 0.0;",
  "Floating Point",
  "entity.name.type",
);
expectScope(grammar, "x = a + b;", "+", "keyword.operator");
expectScope(grammar, "foo(a);", "foo", "entity.name.function");

// Regression (#110): relational `<`/`>` expressions must be operators, never a
// `<…>` type-annotation span. A type annotation only follows `local`/`static
// local`; a bare comparison has no such modifier.
refuteScope(
  grammar,
  "if (Speed < Limit and Gear > Min Gear) { }",
  "Limit and Gear",
  "entity.name.type",
);
expectScope(
  grammar,
  "if (Speed < Limit and Gear > Min Gear) { }",
  "<",
  "keyword.operator",
);
expectScope(
  grammar,
  "if (Speed < Limit and Gear > Min Gear) { }",
  ">",
  "keyword.operator",
);
// Real corpus line: `<` after `local ... =` is a comparison, not an annotation.
refuteScope(
  grammar,
  "local disengage = Temperature Out < (Threshold - Hysteresis);",
  "<",
  "typeannotation",
);
expectScope(
  grammar,
  "local disengage = Temperature Out < (Threshold - Hysteresis);",
  "<",
  "keyword.operator",
);
// The genuine annotation form still works (the `<` immediately follows `local`).
expectScope(
  grammar,
  "static local <Integer> i = -1;",
  "Integer",
  "entity.name.type",
);

// M1 reference keywords (Development Manual): Root/This/Parent/In/Out/Library
// behave like `self`/`this` in other languages — highlight them distinctly even
// when they head a dotted path.
expectScope(grammar, "x = Root.Engine.Rpm;", "Root", "variable.language");
expectScope(grammar, "x = This.Value;", "This", "variable.language");
expectScope(grammar, "x = Parent.State;", "Parent", "variable.language");
expectScope(grammar, "x = Library.Math.Pi;", "Library", "variable.language");
// The leading segment of a (non-keyword) dotted member path is the path root;
// nvim colors it like the rest of the path (a property), not a plain variable.
expectScope(
  grammar,
  "x = Vehicle.SBG.Gyro.Z;",
  "Vehicle",
  "variable.other.property",
);
// A reference keyword at the head of a path must win over the path-root rule.
expectScope(grammar, "x = Root.Engine.Rpm;", "Root", "variable.language");

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
