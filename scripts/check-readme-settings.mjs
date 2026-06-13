// Guard against README rot: every setting contributed by package.json's
// contributes.configuration must appear as a row in the README Settings table.
// Run via `npm test` (wired into the test script alongside check-readme-commands.mjs).
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const readme = fs.readFileSync("README.md", "utf8");

// Collect all contributed setting keys.
const properties = pkg.contributes?.configuration?.properties ?? {};
const settingKeys = Object.keys(properties);

if (settingKeys.length === 0) {
  console.error(
    "check-readme-settings: no contributes.configuration.properties found in package.json — check the path.",
  );
  process.exit(1);
}

// Parse the README Settings table: find every backtick-quoted setting name
// that appears in a table row (lines that start with `|`).
// We look for `` `m1.<something>` `` anywhere in a table row.
const tableSettingPattern = /`(m1\.[^`]+)`/g;
const readmeSettings = new Set();
for (const line of readme.split("\n")) {
  if (!line.trim().startsWith("|")) {
    continue;
  }
  let m;
  while ((m = tableSettingPattern.exec(line)) !== null) {
    readmeSettings.add(m[1]);
  }
}

const missing = settingKeys.filter((k) => !readmeSettings.has(k));

if (missing.length > 0) {
  console.error(
    `README.md Settings table is missing ${missing.length} contributed setting(s):`,
  );
  for (const k of missing) {
    console.error(`  - ${k}`);
  }
  console.error(
    "Add the missing rows to the Settings table in README.md (see scripts/check-readme-commands.mjs for the parallel commands guard).",
  );
  process.exit(1);
}

console.log(
  `README Settings table covers all ${settingKeys.length} contributed settings.`,
);
