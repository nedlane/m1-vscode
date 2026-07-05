// Verifies the VS Code settings surface and buildSettings() stay in lock-step
// (#106): every contributed m1.lint/m1.format/m1.diagnostics setting must have
// a forwarding entry in the extension's settings map, and vice versa — a
// schema addition that touches only one side fails here instead of silently
// never reaching the server.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, "..", p), "utf8");

const pkg = JSON.parse(read("package.json"));
const props = pkg.contributes?.configuration?.properties ?? {};
const contributed = Object.keys(props)
  // m1.lint.path / m1.fmt.path are binary-location settings (consumed by the
  // task provider via resolveBin), not server-forwarded config, so they have no
  // buildSettings() mapping — exclude them from the lock-step check.
  .filter(
    (k) => /^m1\.(lint|format|diagnostics)\./.test(k) && !k.endsWith(".path"),
  )
  .map((k) => k.replace(/^m1\./, ""))
  .sort();

const src = read("src/extension.ts");
const mapped = [
  ...src.matchAll(
    /\["((?:lint|format|diagnostics)\.\w+)", "(?:lint|format|diagnostics)", "\w+"\]/g,
  ),
]
  .map((m) => m[1])
  .sort();

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL: ${msg}`);
};

for (const key of contributed) {
  if (!mapped.includes(key)) {
    fail(`contributed setting m1.${key} has no buildSettings() mapping`);
  }
}
for (const key of mapped) {
  if (!contributed.includes(key)) {
    fail(
      `buildSettings() maps ${key} but package.json does not contribute m1.${key}`,
    );
  }
}
if (mapped.length === 0) {
  fail(
    "could not extract any map entries from src/extension.ts (regex drift?)",
  );
}

if (failures > 0) {
  process.exit(1);
}
console.log(
  `settings-surface: ${contributed.length} contributed settings all mapped (and vice versa)`,
);
