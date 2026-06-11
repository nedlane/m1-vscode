// Guard against README rot (#99): every user-facing `M1:` command contributed
// by package.json must be mentioned in README.md. Tree-only variants
// (m1.projectTree.*) are exempt — they surface through context menus the
// Features section describes as a set.
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const readme = fs.readFileSync("README.md", "utf8");

const missing = [];
for (const cmd of pkg.contributes.commands) {
  if (cmd.command.startsWith("m1.projectTree.")) {
    continue;
  }
  // Match on the human title with the `M1: ` prefix and any trailing ellipsis
  // stripped — the README names commands, not IDs.
  const title = cmd.title.replace(/^M1: /, "").replace(/…$/, "");
  if (!readme.includes(title)) {
    missing.push(`${cmd.command} ("${cmd.title}")`);
  }
}

if (missing.length > 0) {
  console.error(
    `README.md does not mention ${missing.length} contributed command(s):`,
  );
  for (const m of missing) {
    console.error(`  - ${m}`);
  }
  console.error(
    "Update the README Commands/Features sections (see #99) or exempt the command here.",
  );
  process.exit(1);
}
console.log(
  `README mentions all ${pkg.contributes.commands.length} contributed commands (tree variants exempt).`,
);
