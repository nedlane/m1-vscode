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

The released, per-platform VSIXes already **bundle** the matching server binary —
end users need nothing extra (and no network).

### How the server stays in sync (no manual copying)

The server version is **pinned** in `package.json` under `m1.serverVersion`, and
binaries come from [`m1-lsp` GitHub Releases](https://github.com/C-Nucifora/m1-lsp/releases):

- **m1-lsp** (`.github/workflows/release.yml`) builds Linux/macOS/Windows binaries
  and publishes a Release automatically whenever its crate version changes.
- **m1-vscode** `sync-server.yml` (daily / manual) notices a newer m1-lsp release,
  repins `m1.serverVersion`, bumps the extension version, and pushes a tag.
- That tag triggers `release.yml`, which fetches each platform's server binary and
  publishes one VSIX per platform (`vsce package --target …`).

So a new m1-lsp version ships a new extension version with **no manual steps**.
The only one-time setup is a repo secret `GH_PAT` (a PAT with read access to the
private `m1-lsp` repo and push access here).

### Get the server locally (replaces manual `cp`)

```bash
npm run server:fetch          # downloads the pinned server for your platform into server/
# or pin/override explicitly:
node scripts/fetch-server.mjs --version v0.2.0 --target x86_64-apple-darwin
```

(You can still set `m1.server.path` to any local build, or put `m1-lsp` on `PATH`.)

## Develop

```bash
npm install
npm run server:fetch    # fetch the pinned m1-lsp server into server/
npm run build           # bundle to dist/extension.js
npm run compile         # tsc type-check only
npm test                # grammar + end-to-end LSP smoke tests
npm run package         # produce a (current-platform) m1-vscode.vsix
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
