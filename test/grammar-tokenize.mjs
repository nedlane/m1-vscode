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
expectScope(grammar, "local <Boolean> b = true;", "Boolean", "entity.name.type");
expectScope(grammar, "local <boolean> b = true;", "boolean", "entity.name.type");
expectScope(grammar, "local <Integer> i = 0;", "Integer", "entity.name.type");
expectScope(
  grammar,
  "local <Floating Point> f = 0.0;",
  "Floating Point",
  "entity.name.type",
);
expectScope(grammar, "x = a + b;", "+", "keyword.operator");
expectScope(grammar, "foo(a);", "foo", "entity.name.function");

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
