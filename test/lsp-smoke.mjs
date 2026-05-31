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

  // 7) shutdown
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
