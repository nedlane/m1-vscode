// End-to-end smoke test: drives the real m1-lsp binary over stdio LSP and
// asserts that every capability the VS Code extension relies on actually works.
//
// Usage: node test/lsp-smoke.mjs [path-to-m1-lsp]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.argv[2] || path.join(here, "..", "server", "m1-lsp");

const proc = spawn(serverPath, [], { stdio: ["pipe", "pipe", "pipe"] });
proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let buf = Buffer.alloc(0);
const waiters = []; // { predicate, resolve }
const notifications = [];

proc.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buf.slice(0, headerEnd).toString("utf8");
    const m = /Content-Length: (\d+)/i.exec(header);
    if (!m) {
      buf = buf.slice(headerEnd + 4);
      continue;
    }
    const len = parseInt(m[1], 10);
    const start = headerEnd + 4;
    if (buf.length < start + len) break;
    const body = buf.slice(start, start + len).toString("utf8");
    buf = buf.slice(start + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    if (msg.method && msg.id === undefined) notifications.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        waiters.splice(i, 1)[0].resolve(msg);
      }
    }
  }
});

function send(msg) {
  const json = JSON.stringify({ jsonrpc: "2.0", ...msg });
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}
function waitFor(predicate, label, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`timeout waiting for ${label}`)),
      ms,
    );
    waiters.push({
      predicate: (m) => predicate(m),
      resolve: (m) => {
        clearTimeout(t);
        resolve(m);
      },
    });
  });
}
const waitId = (id, label) => waitFor((m) => m.id === id, label);

let pass = 0;
let fail = 0;
function check(cond, label, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

const uri = "file:///tmp/m1-smoke/sample.m1scr";
const text = [
  "// sample script",
  "local count = 0;",
  "local fGain = 1.5;",
  "local flag = true;",
  "count=count+1;", // deliberately mis-spaced to force a formatting edit
  "",
].join("\n");

const main = async () => {
  // 1) initialize
  send({
    id: 1,
    method: "initialize",
    params: {
      processId: process.pid,
      rootUri: "file:///tmp/m1-smoke",
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          synchronization: { didSave: true },
          completion: {},
          documentSymbol: {},
        },
      },
    },
  });
  const init = await waitId(1, "initialize");
  const caps = init.result?.capabilities ?? {};
  console.log("Server capabilities:");
  check(!!caps.documentFormattingProvider, "advertises formatting");
  check(!!caps.hoverProvider, "advertises hover");
  check(!!caps.definitionProvider, "advertises definition");
  check(!!caps.documentSymbolProvider, "advertises documentSymbol");
  check(!!caps.completionProvider, "advertises completion");
  check(!!caps.referencesProvider, "advertises references");
  check(!!caps.documentHighlightProvider, "advertises documentHighlight");
  check(!!caps.foldingRangeProvider, "advertises foldingRange");
  check(!!caps.codeActionProvider, "advertises codeAction");
  check(!!caps.renameProvider, "advertises rename");
  check(
    !!caps.renameProvider?.prepareProvider,
    "rename advertises prepareProvider",
  );
  check(!!caps.inlayHintProvider, "advertises inlayHint");
  check(!!caps.semanticTokensProvider, "advertises semanticTokens");
  check(!!caps.workspaceSymbolProvider, "advertises workspace symbol");
  check(!!caps.documentRangeFormattingProvider, "advertises range formatting");
  check(
    (caps.completionProvider?.triggerCharacters ?? []).includes("."),
    "completion registers '.' trigger",
  );
  check(caps.textDocumentSync !== undefined, "advertises textDocumentSync");

  // 2) initialized + didOpen
  send({ method: "initialized", params: {} });
  send({
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, languageId: "m1scr", version: 1, text },
    },
  });

  console.log("Requests:");
  // 3) hover on `count` in its declaration (line 1, char 6)
  send({
    id: 2,
    method: "textDocument/hover",
    params: { textDocument: { uri }, position: { line: 1, character: 6 } },
  });
  const hover = await waitId(2, "hover");
  const hoverVal =
    hover.result?.contents?.value ??
    (typeof hover.result?.contents === "string" ? hover.result.contents : "");
  check(!hover.error && hover.result != null, "hover returns a result");
  check(
    /type/i.test(hoverVal) || hoverVal.length > 0,
    "hover has content",
    hoverVal,
  );
  // The bundled server is built from m1-lsp main, which infers local types from
  // their initializer — `local count = 0` must resolve to Integer, not Unknown.
  check(
    /Integer/.test(hoverVal) && !/Unknown/.test(hoverVal),
    "hover infers Integer for `local count = 0` (bundled server has type inference)",
    hoverVal,
  );
  console.log(`        hover: ${JSON.stringify(hoverVal).slice(0, 120)}`);

  // 4) formatting
  send({
    id: 3,
    method: "textDocument/formatting",
    params: {
      textDocument: { uri },
      options: { tabSize: 4, insertSpaces: true },
    },
  });
  const fmt = await waitId(3, "formatting");
  check(!fmt.error, "formatting returns without error");
  check(
    Array.isArray(fmt.result) && fmt.result.length > 0,
    "formatting returns non-empty TextEdit[] for mis-formatted input",
    JSON.stringify(fmt.result)?.slice(0, 100),
  );

  // 5) document symbols
  send({
    id: 4,
    method: "textDocument/documentSymbol",
    params: { textDocument: { uri } },
  });
  const syms = await waitId(4, "documentSymbol");
  check(!syms.error, "documentSymbol returns without error");
  check(
    Array.isArray(syms.result),
    "documentSymbol returns an array",
    `count=${syms.result?.length}`,
  );

  // 6) completion
  send({
    id: 5,
    method: "textDocument/completion",
    params: { textDocument: { uri }, position: { line: 4, character: 5 } },
  });
  const comp = await waitId(5, "completion");
  check(!comp.error, "completion returns without error");

  // give diagnostics a moment to arrive
  await new Promise((r) => setTimeout(r, 300));
  const diag = notifications.find(
    (n) => n.method === "textDocument/publishDiagnostics",
  );
  check(!!diag, "server published diagnostics");

  // 7) intrinsic-library diagnostics: open a script that misuses the firmware
  //    library and assert the data-driven rules fire (stateful-conditional,
  //    integrated-only-call, deprecated-overload).
  const badUri = "file:///tmp/m1-smoke/intrinsics.m1scr";
  const badText = [
    "if (ready)",
    "{",
    "    flag = Delay.Rising(sensor > 1.0, 5.0);", // T060 stateful-conditional
    "}",
    "out = PDM.GetOutput(1);", // T061 integrated-only-call
    "h = Serial.GetTransmitHandle(2);", // T062 deprecated-overload
    "",
  ].join("\n");
  const badDiag = waitFor(
    (m) =>
      m.method === "textDocument/publishDiagnostics" &&
      m.params?.uri === badUri &&
      (m.params?.diagnostics?.length ?? 0) > 0,
    "intrinsic diagnostics",
  );
  send({
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: badUri,
        languageId: "m1scr",
        version: 1,
        text: badText,
      },
    },
  });
  const got = await badDiag;
  const codes = new Set(
    (got.params.diagnostics ?? []).map((d) => String(d.code)),
  );
  check(
    codes.has("T060"),
    "stateful-conditional (T060) reported",
    [...codes].join(","),
  );
  check(
    codes.has("T061"),
    "integrated-only-call (T061) reported",
    [...codes].join(","),
  );
  check(
    codes.has("T062"),
    "deprecated-overload (T062) reported",
    [...codes].join(","),
  );

  // 8) references on the local `count` (decl at line 1, char 6).
  send({
    id: 6,
    method: "textDocument/references",
    params: {
      textDocument: { uri },
      position: { line: 1, character: 6 },
      context: { includeDeclaration: true },
    },
  });
  const refs = await waitId(6, "references");
  check(!refs.error, "references returns without error");
  check(
    Array.isArray(refs.result) && refs.result.length === 3,
    "references finds all 3 occurrences of `count`",
    `count=${refs.result?.length}`,
  );

  // 9) documentHighlight on the same local.
  send({
    id: 7,
    method: "textDocument/documentHighlight",
    params: { textDocument: { uri }, position: { line: 1, character: 6 } },
  });
  const hl = await waitId(7, "documentHighlight");
  check(!hl.error, "documentHighlight returns without error");
  check(
    Array.isArray(hl.result) && hl.result.length === 3,
    "documentHighlight marks all 3 occurrences",
    `count=${hl.result?.length}`,
  );

  // 10) foldingRange on the if-block document (badUri, opened above).
  send({
    id: 8,
    method: "textDocument/foldingRange",
    params: { textDocument: { uri: badUri } },
  });
  const folds = await waitId(8, "foldingRange");
  check(!folds.error, "foldingRange returns without error");
  check(
    Array.isArray(folds.result) && folds.result.length >= 1,
    "foldingRange folds the if-block",
    `count=${folds.result?.length}`,
  );

  // 11) codeAction quick-fix for an unsupported C operator.
  const opUri = "file:///tmp/m1-smoke/operator.m1scr";
  const opText = "x = a==b;\n";
  const opDiag = waitFor(
    (m) =>
      m.method === "textDocument/publishDiagnostics" &&
      m.params?.uri === opUri &&
      (m.params?.diagnostics ?? []).some(
        (d) => d.code === "unsupported-c-token",
      ),
    "operator diagnostics",
  );
  send({
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: opUri,
        languageId: "m1scr",
        version: 1,
        text: opText,
      },
    },
  });
  const opGot = await opDiag;
  const cToken = opGot.params.diagnostics.find(
    (d) => d.code === "unsupported-c-token",
  );
  send({
    id: 9,
    method: "textDocument/codeAction",
    params: {
      textDocument: { uri: opUri },
      range: cToken.range,
      context: { diagnostics: [cToken] },
    },
  });
  const actions = await waitId(9, "codeAction");
  check(!actions.error, "codeAction returns without error");
  const quickfix = (actions.result ?? []).find((a) => /eq/.test(a.title ?? ""));
  check(
    !!quickfix && quickfix.kind === "quickfix",
    "codeAction offers a `== -> eq` quick-fix",
    JSON.stringify(actions.result)?.slice(0, 120),
  );
  check(
    !!quickfix?.edit?.changes?.[opUri]?.length,
    "quick-fix carries a WorkspaceEdit",
  );

  // 12) prepareRename + rename on the local `count` (decl at line 1, char 6).
  send({
    id: 10,
    method: "textDocument/prepareRename",
    params: { textDocument: { uri }, position: { line: 1, character: 6 } },
  });
  const prep = await waitId(10, "prepareRename");
  check(!prep.error, "prepareRename returns without error");
  check(
    prep.result != null && typeof prep.result === "object",
    "prepareRename returns a range for a renameable symbol",
    JSON.stringify(prep.result)?.slice(0, 100),
  );
  send({
    id: 11,
    method: "textDocument/rename",
    params: {
      textDocument: { uri },
      position: { line: 1, character: 6 },
      newName: "tally",
    },
  });
  const ren = await waitId(11, "rename");
  check(!ren.error, "rename returns without error");
  const renEdits = ren.result?.changes?.[uri] ?? ren.result?.documentChanges;
  check(
    Array.isArray(renEdits) && renEdits.length === 3,
    "rename rewrites all 3 occurrences of `count`",
    `count=${renEdits?.length}`,
  );

  // 13) inlayHint over the whole sample document.
  send({
    id: 12,
    method: "textDocument/inlayHint",
    params: {
      textDocument: { uri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 5, character: 0 },
      },
    },
  });
  const inlay = await waitId(12, "inlayHint");
  check(!inlay.error, "inlayHint returns without error");
  check(Array.isArray(inlay.result), "inlayHint returns an array");

  // 14) semanticTokens/full over the sample document.
  send({
    id: 13,
    method: "textDocument/semanticTokens/full",
    params: { textDocument: { uri } },
  });
  const sem = await waitId(13, "semanticTokens/full");
  check(!sem.error, "semanticTokens/full returns without error");
  check(
    Array.isArray(sem.result?.data),
    "semanticTokens/full returns a data array",
    `len=${sem.result?.data?.length}`,
  );

  // 15) workspace/symbol query.
  send({
    id: 14,
    method: "workspace/symbol",
    params: { query: "count" },
  });
  const wsym = await waitId(14, "workspace/symbol");
  check(!wsym.error, "workspace/symbol returns without error");
  // With no Project.m1prj loaded the server returns null (valid per spec);
  // when a project is present it returns SymbolInformation[]. Accept either.
  check(
    wsym.result === null || Array.isArray(wsym.result),
    "workspace/symbol returns null-or-array",
    JSON.stringify(wsym.result)?.slice(0, 80),
  );

  // 16) rangeFormatting over the mis-spaced assignment (line 4).
  send({
    id: 15,
    method: "textDocument/rangeFormatting",
    params: {
      textDocument: { uri },
      range: {
        start: { line: 4, character: 0 },
        end: { line: 5, character: 0 },
      },
      options: { tabSize: 4, insertSpaces: true },
    },
  });
  const rfmt = await waitId(15, "rangeFormatting");
  check(!rfmt.error, "rangeFormatting returns without error");
  check(
    Array.isArray(rfmt.result),
    "rangeFormatting returns a TextEdit[]",
    JSON.stringify(rfmt.result)?.slice(0, 100),
  );

  // 17) shutdown
  send({ id: 99, method: "shutdown", params: null });
  await waitId(99, "shutdown");
  send({ method: "exit", params: null });

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  proc.kill();
  process.exit(fail === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error("Test harness error:", err);
  proc.kill();
  process.exit(1);
});
