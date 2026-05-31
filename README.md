# M1 Script for VS Code (`m1-vscode`)

Language support for MoTeC **M1 scripts** (`.m1scr`) in Visual Studio Code.

This is the VS Code counterpart to the Neovim integration in `tree-sitter-m1`. It is
a **thin client**: syntax highlighting and language registration live here; every
language feature is provided by the shared [`m1-lsp`](https://github.com/C-Nucifora/m1-lsp)
server (which in turn drives `m1-fmt`, `m1-core`, `m1-lint`, and the type checker).

## Features

- Syntax highlighting (TextMate grammar mirroring `tree-sitter-m1/queries/highlights.scm`)
- Formatting (`m1-fmt`) — Format Document
- Hover / type information
- Go-to-definition
- Document symbols / outline
- Completion
- Diagnostics from `m1-lint` and the type checker

## Requirements

The extension needs the `m1-lsp` server binary. It is resolved at runtime in this
order:

1. The `m1.server.path` setting (absolute path; supports `~` and `${workspaceFolder}`).
2. A binary bundled in the extension's `server/` directory.
3. `m1-lsp` on your `PATH`.

Build the server from the toolchain workspace:

```bash
cargo build --release -p m1-lsp
# binary at: target/release/m1-lsp
```

Then either set `m1.server.path` to that path, or copy it into `server/m1-lsp`
before packaging.

## Develop

```bash
npm install
npm run build           # bundle to dist/extension.js
npm run compile         # tsc type-check only
npm run package         # produce m1-vscode.vsix
code --install-extension m1-vscode.vsix
```

Press `F5` in VS Code to launch an Extension Development Host.

## Settings

| Setting           | Default | Description                                     |
| ----------------- | ------- | ----------------------------------------------- |
| `m1.server.path`  | `""`    | Absolute path to the `m1-lsp` binary.           |
| `m1.trace.server` | `off`   | Trace LSP traffic (`off`/`messages`/`verbose`). |

## Commands

- **M1: Restart Language Server**
- **M1: Show Language Server Output**

## Layout

```
src/extension.ts                  LSP client (vscode-languageclient)
syntaxes/m1scr.tmLanguage.json    TextMate highlighting
language-configuration.json       comments / brackets / indent
server/                           (optional) bundled m1-lsp binary
```

See `SPEC.md` and `PLAN.md` for design and rationale.
