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
- Go-to-implementation (a channel's write / producer sites)
- Document symbols / outline
- Completion
- Diagnostics from `m1-lint` and the type checker
- **Multi-root workspaces** — one `m1-lsp` server is started per M1 project root
  (`Project.m1prj`) discovered in the workspace, each scoped to its own folder, so
  every project in a multi-root window gets full language features. Single-root
  (and project-less) workspaces use one server as before.
- **Project editing** (via the bundled [`m1-project`](https://github.com/nedlane/m1-project)
  CLI) — commands to **Create Channel**, **Set Component Security**, and **Set Script
  Call Rate** edit `Project.m1prj` for you with validation, instead of hand-editing
  XML. After an edit the language servers reload automatically.

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

- **m1-lsp** (`.github/workflows/release.yml`) builds **Linux x64**, **Windows x64**
  and **Apple-Silicon macOS (arm64)** binaries and publishes a Release automatically
  whenever its crate version changes. (Intel macOS is not built — see below.)
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

### Intel macOS (`x86_64-apple-darwin`)

GitHub no longer reliably provides Intel-Mac CI runners, so there is **no
Intel-Mac VSIX and no prebuilt Intel-Mac server**. Apple-Silicon Macs are fully
supported via the `darwin-arm64` VSIX; Intel-Mac users set it up manually (once):

1. **Install the server-less universal VSIX** from the
   [Releases](https://github.com/nedlane/m1-vscode/releases) page
   (`m1-vscode-universal.vsix`) — it installs on any platform but bundles no
   server:
   ```bash
   code --install-extension m1-vscode-universal.vsix
   ```
2. **Build the server** on your Mac (needs Rust — `https://rustup.rs`):
   ```bash
   git clone https://github.com/C-Nucifora/m1-lsp && cd m1-lsp
   cargo build --release            # -> target/release/m1-lsp
   ```
3. **Point the extension at it** — in VS Code settings:
   ```json
   "m1.server.path": "/absolute/path/to/m1-lsp/target/release/m1-lsp"
   ```
   (or put that `m1-lsp` binary on your `PATH`).

That's it — all language features then work identically to the bundled builds.
The universal VSIX is also the fallback for any other uncovered platform
(e.g. Linux arm64).

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

| Setting                   | Default | Description                                                   |
| ------------------------- | ------- | ------------------------------------------------------------- |
| `m1.server.path`          | `""`    | Absolute path to the `m1-lsp` binary.                         |
| `m1.trace.server`         | `off`   | Trace LSP traffic (`off`/`messages`/`verbose`).               |
| `m1.lint.maxLineLength`   | `88`    | Lint: maximum line length (L001).                             |
| `m1.lint.maxNestingDepth` | `4`     | Lint: maximum block nesting depth (L008).                     |
| `m1.lint.maxComplexity`   | `10`    | Lint: maximum cyclomatic complexity (L009).                   |
| `m1.lint.exclude`         | `[]`    | Lint: glob patterns of files to skip.                         |
| `m1.format.lineWidth`     | `88`    | Formatter: wrap column.                                       |
| `m1.format.maxBlankLines` | `2`     | Formatter: max consecutive blank lines.                       |
| `m1.diagnostics.ignore`   | `[]`    | Disable diagnostics by code, any tool (lint `L*`, type `T*`). |
| `m1.diagnostics.select`   | `[]`    | If non-empty, run ONLY these codes.                           |

These VS Code settings are the convenient default. For **project-level** config
shared with teammates (and with the Neovim plugins), commit an `m1-tools.toml` to
the workspace — it configures the same lint/format/diagnostics options and
**overrides** the VS Code settings. Generate one pre-filled with every default via
the **M1: Generate m1-tools.toml** command.

## Commands

- **M1: Restart Language Server**
- **M1: Show Language Server Output**
- **M1: Show Diagnostic Info**
- **M1: Generate m1-tools.toml** — write a fully-defaulted `m1-tools.toml` to the workspace.

## Layout

```
src/extension.ts                  LSP client (vscode-languageclient)
syntaxes/m1scr.tmLanguage.json    TextMate highlighting
language-configuration.json       comments / brackets / indent
server/                           (optional) bundled m1-lsp binary
```

See `SPEC.md` and `PLAN.md` for design and rationale.

## License

Licensed under the GNU General Public License v3.0 or later (GPL-3.0-or-later) — see [LICENSE](LICENSE).

Copyright (C) 2026 The M1 Tools authors.

## Trademark

Independent, community-built open-source tooling for the MoTeC® M1 script
language. Not affiliated with, authorised, or endorsed by MoTeC Pty Ltd.
"MoTeC" and "M1" are trademarks of MoTeC Pty Ltd.
