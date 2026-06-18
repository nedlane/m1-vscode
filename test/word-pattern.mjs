// Verifies language-configuration.json defines a wordPattern that treats a
// space-containing M1 identifier as a single word.
//
// M1 identifiers routinely contain spaces — the manual references e.g.
// `In.Filter Constant`, `Min Gear`; the real corpus has channels like
// `Rear Left Torque`, `One Pedal Enable`, `Driver Throttle`. With no
// wordPattern, VS Code falls back to its default which treats whitespace as a
// word boundary, so double-clicking a multi-word channel selects only one word
// and Ctrl+Left/Right word motions stop mid-name.
//
// This test models VS Code's getWordRangeAtPosition: it scans the line with the
// configured wordPattern (as a global regex) and returns the match whose range
// contains the cursor. We assert that landing the cursor anywhere inside a
// multi-word channel selects the whole name, while operators and the M1 word
// operators (and/or/not/eq/neq — Development Manual, Operators) still split
// expressions correctly so the pattern is not greedy across
// `if (Speed < Limit and Gear > Min Gear)`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, "..", p), "utf8");

const cfg = JSON.parse(read("language-configuration.json"));

let pass = 0;
let fail = 0;
const check = (ok, msg) => {
  if (ok) {
    console.log(`  PASS  ${msg}`);
    pass++;
  } else {
    console.log(`  FAIL  ${msg}`);
    fail++;
  }
};

console.log("language-configuration.json wordPattern:");

check(
  typeof cfg.wordPattern === "string" && cfg.wordPattern.length > 0,
  "wordPattern is defined",
);

// Build the global regex the way VS Code does for getWordRangeAtPosition.
let wp;
try {
  wp = new RegExp(cfg.wordPattern ?? "", "g");
  check(true, "wordPattern compiles as a regular expression");
} catch (e) {
  check(false, `wordPattern compiles as a regular expression (${e.message})`);
}

// Model VS Code's getWordRangeAtPosition: the word at `col` is the wordPattern
// match whose [start,end) range contains col (end is inclusive of the boundary
// so a cursor at the end of a word still selects it).
function wordAt(line, col) {
  wp.lastIndex = 0;
  let m;
  while ((m = wp.exec(line)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (col >= start && col <= end) return m[0];
    if (m.index === wp.lastIndex) wp.lastIndex++; // guard against zero-width
  }
  return undefined;
}

if (wp) {
  // Double-clicking anywhere inside a multi-word channel selects the whole name.
  const line1 = "\tRear Left Torque = Driver Throttle * 100.0;";
  const idxRear = line1.indexOf("Rear Left Torque");
  for (const probe of ["Rear", "Left", "Torque"]) {
    const col = line1.indexOf(probe);
    check(
      wordAt(line1, col) === "Rear Left Torque",
      `cursor on "${probe}" selects the whole channel "Rear Left Torque"`,
    );
  }
  // The right-hand multi-word channel selects independently of the first.
  check(
    wordAt(line1, line1.indexOf("Throttle")) === "Driver Throttle",
    'cursor on "Throttle" selects "Driver Throttle", not across the `=`',
  );
  check(idxRear === 1, "fixture sanity: channel starts after the leading tab");

  // A dotted member with a space selects the member as one word.
  const line2 = "Control.Drive State.AsInteger()";
  check(
    wordAt(line2, line2.indexOf("State")) === "Drive State",
    'cursor on "State" selects the member "Drive State"',
  );

  // Not greedy across operators: a relational expression must still split into
  // its operand channels rather than swallowing the operator and the next name.
  const line3 = "if (Maximum Cell Temp > Maximum Allowable Cell Temp)";
  check(
    wordAt(line3, line3.indexOf("Cell")) === "Maximum Cell Temp",
    'left operand "Maximum Cell Temp" selects without crossing ">"',
  );
  check(
    wordAt(line3, line3.indexOf("Allowable")) === "Maximum Allowable Cell Temp",
    'right operand "Maximum Allowable Cell Temp" selects on its own',
  );

  // Not greedy across the M1 word operators (and/or/not/eq/neq): they must not
  // be absorbed into an adjacent channel name.
  const line4 = "if (Speed < Limit and Gear > Min Gear)";
  check(
    wordAt(line4, line4.indexOf("Limit")) === "Limit",
    '"Limit" selects alone, not "Limit and Gear"',
  );
  check(
    wordAt(line4, line4.indexOf("Min Gear")) === "Min Gear",
    '"Min Gear" selects as the full channel name',
  );

  // The `and` inside an identifier (android) is NOT treated as the operator.
  const line5 = "android State = 0;";
  check(
    wordAt(line5, 0) === "android State",
    '"android State" stays one word (word-boundary guards the operator)',
  );

  // The guard list is the actual M1 word-operator set (and/or/not/eq/neq), so
  // `eq`/`neq` split operands and are NOT absorbed into an adjacent channel —
  // this keeps word selection aligned with the TextMate grammar's
  // #word-operators rule. (`Channel A eq Channel B` per the Development Manual.)
  const line6 = "if (Channel A eq Channel B) { }";
  check(
    wordAt(line6, line6.indexOf("Channel A")) === "Channel A",
    '"Channel A" selects alone, not "Channel A eq Channel B"',
  );
  check(
    wordAt(line6, line6.indexOf("eq")) === "eq",
    '"eq" selects as the word operator, not as part of a channel',
  );
}

console.log(`\nword-pattern: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
