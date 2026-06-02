// Verifies the bundled m1-lsp server's `--scaffold-config` output — the contract
// the "M1: Generate m1-tools.toml" command relies on. Runs the real binary so a
// server bump that changes (or breaks) the scaffold is caught here.
//
// Usage: node test/scaffold.mjs [path-to-m1-lsp]
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = process.argv[2] || path.join(here, "..", "server", "m1-lsp");

let out;
try {
  out = execFileSync(serverPath, ["--scaffold-config"], { encoding: "utf8" });
} catch (e) {
  console.error(`Failed to run ${serverPath} --scaffold-config: ${e.message}`);
  process.exit(1);
}

const must = [
  "[lint]",
  "max_line_length",
  "[format]",
  "line_width",
  "[diagnostics]",
  "ignore = []",
  "select = []",
  "L001", // a lint code is listed
  "T001", // a typecheck code is listed
];
const missing = must.filter((s) => !out.includes(s));
if (missing.length > 0) {
  console.error(`scaffold output missing: ${missing.join(", ")}`);
  console.error("--- output ---\n" + out);
  process.exit(1);
}

// Every non-comment line must be a section header or a `key = value` — i.e. it
// should be a parseable TOML body, not prose.
for (const line of out.split("\n")) {
  const t = line.trim();
  if (t === "" || t.startsWith("#")) continue;
  if (!/^\[[a-z]+\]$/.test(t) && !/^[a-z_]+ =/.test(t)) {
    console.error(
      `unexpected non-TOML line in scaffold: ${JSON.stringify(line)}`,
    );
    process.exit(1);
  }
}

console.log("scaffold.mjs: ok — --scaffold-config emits a valid m1-tools.toml");
