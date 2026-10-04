# AGENTS.md — m1-vscode

Guidance for coding agents working in this repository.

## Purpose

The VS Code client for the M1 toolchain. Deliberately **thin**: language
intelligence lives in `m1-lsp`, project mutations in the `m1-project` CLI —
this extension registers the language, starts the server, surfaces the verbs
as `M1:` commands/tree actions, and bundles the binaries. If you find
yourself implementing analysis or XML editing in TypeScript here, it belongs
upstream.

## Things that are deliberate (don't "fix" them)

- **The bundled tool pins are automated.** `sync-server.yml` (daily) proposes one reviewed PR for the latest complete
  m1-lsp, m1-fmt, m1-lint and m1-project releases. It checks all three platform
  assets and SHA256SUMS before repinning `package.json` and bumping the
  extension version. After merge, the tag and release workflows publish the
  per-platform VSIXes. The PR workflow requires `GH_PAT`; it never auto-merges. Don't hand-edit the pin outside that
  flow without a reason.
- **The client appends `--stdio`** when launching the server
  (vscode-languageclient behaviour). The server must keep accepting it; if
  server startup fails with EPIPE/startFailed, check this first.
- **The README Commands list is CI-enforced** —
  `scripts/check-readme-commands.mjs` fails when a contributed command is
  missing from the README. Adding a command means adding it there too.
- **Per-platform VSIXes + a server-less universal fallback.** Intel macOS
  has no CI runner, so it's deliberately unbundled — don't try to "add" it.

## CI gates (all must pass; they are separate jobs)

```sh
npm test                # grammar tokenise + contributes + lsp smoke
npm run compile         # tsc type-check, no emit
npm run format:check    # prettier — separate from npm test; easy to miss
```

The VS Code **Extension Host** integration test needs a graphical display —
headless environments skip the bugs only a real client surfaces (e.g. the
push+pull double-diagnostics case). Under WSL, run it with WSLg
(`DISPLAY=:0`). Treat protocol-level changes as untested until they've run in
a real Extension Host.

## Layout

- `src/extension.ts` — activation + command registration
- `src/lsp-client.ts` — server lifecycle (one client per project root;
  multi-root means multiple servers)
- `src/project-commands.ts` / `src/project-tree.ts` — m1-project verbs and
  the explorer view
- `syntaxes/m1scr.tmLanguage.json` — TextMate baseline (semantic tokens from
  the server refine it)
- `server/` — bundled binaries (fetched by `npm run server:fetch`, not
  committed)
