# M1 Script for VS Code (`m1-vscode`)

Language support for MoTeC **M1 scripts** (`.m1scr`) in Visual Studio Code.

It is a **thin client**: syntax highlighting and language registration live
here; every language feature is provided by the shared
[m1-lsp](https://github.com/C-Nucifora/m1-lsp) server, and project editing by
the bundled [m1-project](https://github.com/nedlane/m1-project) CLI. The
Neovim counterpart is [nvim-m1](https://github.com/C-Nucifora/nvim-m1).

## Install

Download the VSIX for your platform from the
[Releases page](https://github.com/nedlane/m1-vscode/releases) and install
it:

```sh
code --install-extension m1-vscode-<platform>.vsix
```

The per-platform VSIXes bundle the matching `m1-lsp` and `m1-project`
binaries — end users need nothing extra and no network. (Intel macOS and
other uncovered platforms: see below.)

## Features

- **Syntax highlighting** — a TextMate baseline refined by LSP semantic
  tokens, so channels, groups, parameters and member paths are resolved
  against the project model rather than guessed by regex.
- **Language features** — diagnostics (syntax, lint, type), hover,
  completion, go-to-definition and -implementation, references, rename,
  document symbols, formatting, inlay hints, code actions, call hierarchy.
- **Multi-root workspaces** — one server per M1 project root, each scoped to
  its own folder.
- **M1 Project explorer** — a tree view of the project's component hierarchy
  with context-menu editing actions.
- **Project editing** — the full `m1-project` verb set as `M1:` commands
  (create channels/parameters/constants/tables/groups/functions; set
  security, type, unit, call rate, display properties, tags; rename, delete,
  validate). Every edit is validated by the CLI instead of hand-editing XML,
  and the language servers reload automatically afterwards.
- **Extras** — a security-matrix overview webview, an `m1` task type with
  problem matcher, and a *Get started with M1* walkthrough.

## The server binary

The extension resolves `m1-lsp` in this order:

1. the `m1.server.path` setting (supports `~` and `${workspaceFolder}`),
2. the binary bundled in the extension's `server/` directory,
3. `m1-lsp` on your `PATH`.

Releases track the server automatically: a daily workflow notices a new
m1-lsp release, repins, and publishes a new extension version — so the
bundled server is never stale.

### Intel macOS and other uncovered platforms

GitHub no longer reliably provides Intel-Mac CI runners, so there is no
Intel-Mac VSIX or prebuilt server. Install the server-less
`m1-vscode-universal.vsix` from Releases, build `m1-lsp` yourself
(`cargo build --release` in its repo), and set `m1.server.path` to the
binary. All features then work identically to the bundled builds.

## Settings

| Setting                   | Default | Description                                                   |
| ------------------------- | ------- | ------------------------------------------------------------- |
| `m1.server.path`          | `""`    | Absolute path to the `m1-lsp` binary.                         |
| `m1.project.path`         | `""`    | Absolute path to the `m1-project` binary (else bundled/PATH). |
| `m1.trace.server`         | `off`   | Trace LSP traffic (`off`/`messages`/`verbose`).               |
| `m1.lint.maxLineLength`   | `88`    | Lint: maximum line length (L001).                             |
| `m1.lint.maxNestingDepth` | `4`     | Lint: maximum block nesting depth (L008).                     |
| `m1.lint.maxComplexity`   | `10`    | Lint: maximum cyclomatic complexity (L009).                   |
| `m1.lint.exclude`         | `[]`    | Lint: glob patterns of files to skip.                         |
| `m1.format.lineWidth`     | `88`    | Formatter: wrap column.                                       |
| `m1.format.maxBlankLines` | `2`     | Formatter: max consecutive blank lines.                       |
| `m1.diagnostics.ignore`   | `[]`    | Disable diagnostics by code, any tool (lint `L*`, type `T*`). |
| `m1.diagnostics.select`   | `[]`    | If non-empty, run ONLY these codes.                           |

These VS Code settings are the convenient default. For **project-level**
config shared with teammates (and with the Neovim plugins), commit an
`m1-tools.toml` to the workspace — it configures the same options and
overrides the VS Code settings (see the
[m1-tools configuration docs](https://github.com/C-Nucifora/m1-tools#configuration)).
Generate one via **M1: Generate m1-tools.toml**.

## Commands

Server / tooling:

- **M1: Restart Language Server** · **M1: Show Language Server Output**
- **M1: Show Diagnostic Info** — extension, running-server and pinned versions,
  paths, per-client capabilities
- **M1: Generate m1-tools.toml** — write a fully-defaulted `m1-tools.toml` to the workspace

Project editing (all backed by the bundled `m1-project` CLI; see Features):

- Create: **M1: Create Channel…**, **M1: Create Parameter**,
  **M1: Create Constant…**, **M1: Create Table…** (1–3 axes),
  **M1: Create Group…**, **M1: Create Function**,
  **M1: Create Scheduled Function**
- Set: **M1: Set Component Security…**, **M1: Set Component Type**,
  **M1: Set Component Unit**, **M1: Set Quantity**,
  **M1: Set Validation Bounds**, **M1: Set Display Format**,
  **M1: Set Decimal Places**, **M1: Set Display Range**,
  **M1: Set Script Call Rate…**
- **M1: Add Tag** / **M1: Remove Tag**, **M1: Rename Component…**,
  **M1: Delete Component…**
- **M1: Validate Project**, **M1: Show Security Matrix**,
  **M1: Refresh Project Explorer**

The same actions are available from the **M1 Project** tree's context menus.
This list is guarded against rot: `node scripts/check-readme-commands.mjs`
(run in CI alongside the contributes test) fails when a contributed command
is missing here.

## Develop

```sh
npm install
npm run server:fetch    # fetch the pinned m1-lsp server into server/
npm run build           # bundle to dist/extension.js
npm test                # grammar + contributes + end-to-end LSP smoke tests
npm run package         # produce a (current-platform) m1-vscode.vsix
```

Press `F5` in VS Code to launch an Extension Development Host. CI also gates
on `npm run compile` (type-check) and `npm run format:check` (prettier).

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).

## Trademark

Independent, community-built open-source tooling for the MoTeC® M1 script
language. Not affiliated with, authorised, or endorsed by MoTeC Pty Ltd.
"MoTeC" and "M1" are trademarks of MoTeC Pty Ltd.
