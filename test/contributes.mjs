// Verifies package.json wires the m1-lsp semantic tokens into theme colors.
//
// m1-lsp emits semantic tokens (see m1-lsp src/features/semantic_tokens.rs
// `legend()`), but VS Code only colors them if the extension either relies on a
// theme's native semantic support OR maps the token types to TextMate scopes via
// `contributes.semanticTokenScopes`. Without that mapping, channels (property),
// groups (namespace), parameters, etc. render flat on most themes. We also force
// `editor.semanticHighlighting.enabled` on for the language so a theme that
// hasn't opted in still shows them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.join(here, "..", "package.json"), "utf8"),
);

// The m1-lsp legend (semantic_tokens.rs). These are the token *types* the server
// can emit; every one must have a scope mapping so no theme leaves it uncolored.
const LEGEND_TYPES = [
  "variable",
  "function",
  "keyword",
  "number",
  "string",
  "comment",
  "type",
  "parameter",
  "namespace",
  "property",
];

let pass = 0;
let fail = 0;
function check(ok, msg) {
  if (ok) {
    console.log(`  PASS  ${msg}`);
    pass++;
  } else {
    console.log(`  FAIL  ${msg}`);
    fail++;
  }
}

console.log("package.json contributes:");

// 1. semanticTokenScopes exists and targets our language.
const sts = pkg.contributes?.semanticTokenScopes;
check(Array.isArray(sts) && sts.length > 0, "semanticTokenScopes is present");

const m1Entry = (sts ?? []).find((e) => e.language === "m1scr");
check(!!m1Entry, "semanticTokenScopes has an entry for language m1scr");

// 2. Every legend token type maps to at least one non-empty TextMate scope.
const scopes = m1Entry?.scopes ?? {};
for (const t of LEGEND_TYPES) {
  const v = scopes[t];
  const ok =
    (Array.isArray(v) &&
      v.length > 0 &&
      v.every((s) => typeof s === "string")) ||
    typeof v === "string";
  check(ok, `token type "${t}" maps to a TextMate scope`);
}

// 3. configurationDefaults enables semantic highlighting for [m1scr].
const cfg = pkg.contributes?.configurationDefaults?.["[m1scr]"];
check(
  cfg?.["editor.semanticHighlighting.enabled"] === true,
  "configurationDefaults enables semantic highlighting for [m1scr]",
);

// 4. configurationDefaults pins this extension as the default formatter for
// [m1scr]. The extension supplies document formatting through m1-lsp, so
// "Format Document" / format-on-save must work with zero configuration rather
// than popping the "Select a default formatter" picker. The id is derived from
// publisher.name so it stays in sync if either ever changes.
const formatterId = `${pkg.publisher}.${pkg.name}`;
check(
  cfg?.["editor.defaultFormatter"] === formatterId,
  `configurationDefaults sets editor.defaultFormatter to "${formatterId}" for [m1scr]`,
);

// 5. configurationDefaults enables format-on-type for [m1scr]. m1-lsp
// advertises documentOnTypeFormattingProvider with trigger character "}"
// (backend.rs: DocumentOnTypeFormattingOptions { first_trigger_character: "}" }),
// built to re-indent the just-closed block to the manual's tab + Allman layout
// the instant the user types "}". vscode-languageclient registers the provider
// when that capability is present, but VS Code only invokes it when
// editor.formatOnType is true (which defaults to false). Turning it on here —
// language-scoped so it does not touch the user's other files — makes that built
// server feature live by default instead of dormant.
check(
  cfg?.["editor.formatOnType"] === true,
  "configurationDefaults enables editor.formatOnType for [m1scr]",
);

console.log(`\ncontributes: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
