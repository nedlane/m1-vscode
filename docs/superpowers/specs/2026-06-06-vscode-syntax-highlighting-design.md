# VS Code syntax highlighting parity with Neovim

**Date:** 2026-06-06
**Repo:** m1-vscode
**Status:** approved (approach delegated to implementer)

## Problem

The VS Code extension's `.m1scr` syntax highlighting is markedly worse than the
Neovim plugin's. In Neovim, highlighting is driven by tree-sitter
(`tree-sitter-m1/queries/highlights.scm`, ~108 lines of AST-aware captures:
`@property`, `@namespace`, `@variable.parameter`, method-vs-function,
type-annotation brackets, etc.), and every colorscheme styles those groups.

VS Code has two highlighting layers and **both are underpowered**:

1. **TextMate grammar** (`syntaxes/m1scr.tmLanguage.json`, ~121 lines) — the
   always-on baseline. Regex-based, so it cannot make AST distinctions
   (e.g. `Drive.Speed` = channel vs `local x` = variable). It also does not
   highlight M1 reference keywords (`Root`, `This`, `Parent`, `In`, `Out`,
   `Library`) or the root segment of a dotted member path.
2. **LSP semantic tokens** — `m1-lsp` v0.25.0 already emits **rich** semantic
   tokens (`src/features/semantic_tokens.rs`): channels→`property`,
   groups/objects→`namespace`, parameters→`parameter`, constants→`variable`
   +`readonly`, locals→`variable`+`definition`, types, functions/methods. This is
   as good as or better than the nvim queries. **But the client throws it away:**
   `package.json` has no `semanticTokenScopes` mapping and no
   `configurationDefaults`, so on most themes these token types receive no color
   and (for some users) semantic highlighting isn't even enabled.

**Observed symptom (confirmed with user):** keywords/strings/comments are
colored (TextMate handles them) but channels, groups, parameters, member paths,
and function calls render flat/dull — the exact signature of semantic tokens
being produced server-side and ignored client-side.

## Goal

Bring VS Code highlighting up to Neovim quality, using VS Code-native
mechanisms. Embedding tree-sitter-WASM is explicitly out of scope: VS Code has
no stable extension API for tree-sitter-driven highlighting, and it would
duplicate the model `m1-lsp` already computes (violating the toolchain's
no-duplication / stay-in-sync contract).

## Approach (chosen)

Robust combination — surface the semantic tokens the server already produces
**and** strengthen the TextMate baseline so the result looks good with or
without semantic highlighting engaged.

### 1. Connect semantic tokens to theme colors — `package.json`

Add `contributes.semanticTokenScopes` mapping every token type in the server's
legend to standard TextMate scopes, so **any** theme colors them (including
themes without native semantic support, which fall back to these scopes):

| Semantic token         | TextMate scope(s)                                   |
|------------------------|-----------------------------------------------------|
| `namespace`            | `entity.name.namespace`, `support.class`            |
| `type`                 | `entity.name.type`, `support.type`                  |
| `parameter`            | `variable.parameter`                                |
| `property`             | `variable.other.property`                           |
| `function`             | `entity.name.function`                              |
| `variable`             | `variable.other.readwrite`                          |
| `variable.readonly`    | `variable.other.constant`                           |
| `property.readonly`    | `variable.other.constant.property`                  |

Add `contributes.configurationDefaults` so semantic highlighting is on for the
language regardless of the active theme's opt-in:

```json
"configurationDefaults": {
  "[m1scr]": { "editor.semanticHighlighting.enabled": true }
}
```

### 2. Strengthen the TextMate baseline — `syntaxes/m1scr.tmLanguage.json`

So the always-on layer (and themes/users with semantic highlighting off) is
good on its own:

- **Reference keywords**: highlight `Root`, `This`, `Parent`, `In`, `Out`,
  `Library` as `variable.language.m1scr` (the M1 manual's reference keywords).
- **Member-path root**: color the leading identifier of a dotted path
  (identifier immediately followed by `.`) so `Vehicle` in
  `Vehicle.SBG.IMU.Gyro.Z` is no longer plain — matching nvim, which colors the
  path root like a property.
- Keep all existing patterns; do not regress current scopes.

The semantic-token layer remains authoritative where present — it refines the
TextMate guesses with the resolved model — but the baseline now degrades
gracefully.

## Components & boundaries

- `package.json` `contributes` — declarative; no code. Tested by a structural
  assertion that every legend token type has a scope mapping and that
  `configurationDefaults` enables semantic highlighting.
- `m1scr.tmLanguage.json` — regex grammar; tested by the existing
  `vscode-textmate`-based tokenizer harness.
- No change to `src/extension.ts`: `vscode-languageclient` already negotiates and
  forwards semantic tokens automatically once the server advertises the
  capability (it does).

## Testing

- **Grammar** (`test/grammar-tokenize.mjs`): extend with cases for reference
  keywords (`Root`/`This`/`Parent` → `variable.language`) and member-path root
  (leading segment → property-ish scope). Run via `npm run test:grammar`.
- **Contributions** (new `test/contributes.mjs`): assert `package.json`
  `semanticTokenScopes` covers every type in the server legend
  (`variable, function, keyword, number, string, comment, type, parameter,
  namespace, property`) and that `configurationDefaults["[m1scr]"]` enables
  semantic highlighting. Wire into the `test` script.
- **Manual smoke**: build the VSIX, open an EV-M1 `.m1scr`, confirm channels,
  groups, parameters, function calls, and reference keywords are distinctly
  colored and visually comparable to nvim.

## Versioning / release

Patch-level extension bump (0.4.11 → 0.4.12); no server pin change. Follows the
repo's normal PR → auto-ship pipeline. Server stays at v0.25.0.

## Out of scope

- tree-sitter-WASM highlighting in VS Code (no stable API; duplicative).
- Changes to `m1-lsp` semantic-token classification (already rich; no gap found).
- Theme authoring — we map to standard scopes existing themes already color.
