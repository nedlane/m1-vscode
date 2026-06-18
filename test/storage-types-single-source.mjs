// Unit test: the M1 storage-type list must have a SINGLE source of truth.
//
// project-commands.ts offers a storage-type picker in three places:
//   - createChannel    (channel storage type)
//   - createParameter  (parameter storage type)
//   - setChannelType   (set an existing component's storage type)
//
// setChannelType's options derive from the STORAGE_TYPES constant. The two
// creators historically INLINED the same literal
//   ["(none)", "f32", "f64", "u8", "u16", "u32", "s8", "s16", "s32", "bool"]
// so the nine types were written out three times and had to be kept
// byte-identical by hand. Adding/removing an M1 storage type meant editing
// three copies; nothing enforced they agree.
//
// This test guards against that duplication by reading src/project-commands.ts
// and asserting the bare storage-type literal (the nine types, sans the
// "(none)" sentinel) appears only ONCE — i.e. one canonical STORAGE_TYPES
// definition, with the creators reusing it.
//
// Does NOT need a live VS Code Extension Host.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);

const src = fs.readFileSync(
  path.join(repo, "src", "project-commands.ts"),
  "utf8",
);

let failures = 0;
function check(ok, label) {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    console.error(`  FAIL  ${label}`);
    failures++;
  }
}

// The nine M1 storage types, as a literal array body (whitespace-insensitive).
const STORAGE_TYPES = [
  "f32",
  "f64",
  "u8",
  "u16",
  "u32",
  "s8",
  "s16",
  "s32",
  "bool",
];

// Count how many times the full bare nine-type sequence appears in source.
// Normalise whitespace so formatting differences don't matter.
const normalised = src.replace(/\s+/g, "");
const bareSequence = STORAGE_TYPES.map((t) => `"${t}"`).join(",");
const bareCount = normalised.split(bareSequence).length - 1;

check(
  bareCount === 1,
  `the nine-type storage list appears exactly once in source ` +
    `(single source of truth); found ${bareCount} copies`,
);

// Each individual type string should not be sprinkled across many literals.
// "f32" is a good probe: it should appear only in the canonical definition
// (once) — not re-typed inside each picker.
const f32Count = src.split('"f32"').length - 1;
check(
  f32Count === 1,
  `"f32" is written once (one canonical list); found ${f32Count} occurrences`,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nstorage-types-single-source: all checks passed");
