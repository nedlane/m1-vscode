# m1-vscode — Specification

## Goal

Bring the full M1 (`.m1scr`) editing experience to **Visual Studio Code**, matching
the existing Neovim integration, by reusing the existing `m1-lsp` language server.

## Background

The M1 toolchain already exposes its language intelligence through `m1-lsp`, a
standard LSP server (`tower_lsp`) communicating over **stdio**. It advertises:

| Capability            | Source            | LSP method                         |
|-----------------------|-------------------|------------------------------------|
| Formatting            | `m1-fmt`          | `textDocument/formatting`          |
| Hover / type info     | `m1-core` + types | `textDocument/hover`               |
| Go-to-definition      | `m1-lsp`          | `textDocument/definition`          |
| Document symbols      | `m1-lsp`          | `textDocument/documentSymbol`      |
| Completion            | `m1-lsp`          | `textDocument/completion`          |
| Diagnostics           | `m1-lint`, types  | `textDocument/publishDiagnostics`  |

Because VS Code is an LSP client, **every one of these works in VS Code with no
server changes** — they are delivered the moment a client extension launches the
server and points it at `.m1scr` documents.

The only Neovim-specific pieces are:
1. **Syntax highlighting** — provided in Neovim by `tree-sitter-m1` queries
   (`highlights.scm`). Stock VS Code does not consume nvim-treesitter grammars,
   so highlighting must be re-expressed as a **TextMate grammar**.
2. **Client wiring** — Neovim's `vim.lsp`. VS Code needs its own client.

A VS Code extension is therefore **required** (the server cannot register a
language or start itself inside VS Code). The extension is kept deliberately thin:
it owns only highlighting + language registration + the LSP client; all language
features remain in `m1-lsp`.

## Scope

In scope:
- `m1scr` language registration + `.m1scr` file association.
- Language configuration (comments `//` `/* */`, brackets, auto-closing, indent).
- TextMate grammar mirroring `tree-sitter-m1/queries/highlights.scm`.
- LSP client (`vscode-languageclient`) spawning `m1-lsp` over stdio, wiring up all
  six capabilities above.
- Server discovery: `m1.server.path` setting → bundled `server/` binary → `m1-lsp`
  on `PATH`.
- Commands: restart server, show output channel.
- Packaging to `.vsix`; CI to build + typecheck + package.

Out of scope (future):
- Semantic-tokens highlighting in `m1-lsp` (would let both editors share one
  highlight source; noted as a follow-up, not required for parity).
- Marketplace publishing (this is a private internal extension).
- Bundling per-platform server binaries in git (CI/users build with cargo).

## Language facts (from `tree-sitter-m1/grammar.js`)

- Keywords: `local`, `static`; conditional `if`, `else`, `when`, `is`; loop
  `expand`, `to`; word-operators `and`, `or`, `not`, `eq`, `neq`.
- Booleans: `true`, `false`.
- Numbers: hex `0x…[u]`, float `\d+\.\d+([eE][+-]?\d+)?`, exp `\d+[eE]…`, int `\d+[u]`.
- Strings: `"…"` (no escape sequences in the grammar).
- Comments: line `// …`, block `/* … */`.
- Interpolation: `$(NAME)` — compile-time macro.
- Type annotation: `<Type Name>` (the inner name may contain spaces, e.g.
  `<Unsigned Integer>`); angle brackets are punctuation here, not operators.

## Acceptance criteria

1. `m1-lsp` release binary starts and completes an LSP `initialize` handshake.
2. Opening a `.m1scr` document activates the extension and starts the server.
3. The server reports formatting, hover, definition, documentSymbol and completion
   providers; diagnostics publish on open/change.
4. End-to-end LSP exercise (initialize → didOpen → hover/formatting/symbols)
   returns valid responses against a real corpus script.
5. `.m1scr` files receive TextMate highlighting (keywords, strings, numbers,
   comments, interpolation, type annotations).
6. Extension compiles, packages to `.vsix`, and installs into the locally
   installed VS Code.
