# m1-vscode — Implementation Plan

## Architecture

```
VS Code  ──activates on .m1scr──►  extension (TypeScript)
                                      │  vscode-languageclient
                                      ▼  spawn (stdio)
                                   m1-lsp  ──►  m1-fmt / m1-core / m1-lint / typecheck
TextMate grammar (syntaxes/m1scr.tmLanguage.json) ──►  highlighting (client-side)
language-configuration.json ──►  comments / brackets / indent
```

Thin client: highlighting + language config + LSP launch only. All language
features come from `m1-lsp`.

## Steps

1. **Scaffold** — `package.json` (contributes: languages, grammars, configuration,
   commands; activation `onLanguage:m1scr`), `tsconfig.json`, `esbuild.mjs`,
   `.gitignore`, `.vscodeignore`.
2. **Language config** — `language-configuration.json`: `//` + `/* */` comments,
   `() {} <>` brackets, auto-close pairs, indentation on `{`/`}`.
3. **Highlighting** — `syntaxes/m1scr.tmLanguage.json` mirroring `highlights.scm`:
   comments, strings, numbers, booleans, keyword classes, word/symbol operators,
   `$(…)` interpolation (`constant.other`), `<Type Name>` annotation
   (`entity.name.type`), punctuation.
4. **Client** — `src/extension.ts`: resolve server (`m1.server.path` →
   `server/m1-lsp[.exe]` → `PATH`), `LanguageClient` with stdio `ServerOptions`,
   `documentSelector: m1scr`, output channel, `m1.restartServer` command, graceful
   error if server missing.
5. **Server binary** — build `cargo build --release -p m1-lsp`; copy into `server/`
   for local packaging (git-ignored). Resolution falls back to `PATH`.
6. **CI** — `.github/workflows/ci.yml`: install deps, `tsc --noEmit`, build cargo
   server (for tests), package `.vsix` artifact.
7. **Test against installed versions**:
   - LSP transport: raw JSON-RPC `initialize` → `initialized` → `didOpen` (real
     corpus script) → `hover`, `formatting`, `documentSymbol`; assert valid
     responses + advertised capabilities. (headless, authoritative)
   - Extension: `tsc --noEmit` typecheck, `esbuild` bundle, `npx vsce package`,
     then `code --install-extension m1-vscode-*.vsix` into VS Code 1.120.0.
8. **Publish** — create **private** GitHub repo `m1-vscode`, push, add
   collaborator **C-Nucifora**.

## Decisions / trade-offs

- **TextMate over semantic tokens (for now):** TextMate is offline, zero-latency,
  and the standard VS Code path; it gives immediate parity. Semantic tokens in
  `m1-lsp` would unify highlighting across editors but is a server feature change —
  recorded as a follow-up, not blocking parity.
- **Server not committed to git:** platform-specific 5 MB binary; CI/users build
  it. Extension resolves the binary at runtime.
- **Engine floor `^1.85`:** broad compatibility; tested on installed 1.120.0.
