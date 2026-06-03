// Multi-root variant of runTest: launches VS Code on a .code-workspace that lists
// two separate M1 projects (multiroot/a, multiroot/b) and runs the multi-root
// suite, which asserts each project's files are served by their own LSP client.
const path = require("path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(
    __dirname,
    "./suite-multiroot/index.cjs",
  );
  const workspace = path.resolve(__dirname, "./multiroot.code-workspace");
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace, "--no-sandbox", "--disable-gpu"],
    });
  } catch (err) {
    console.error("Multi-root integration tests failed:", err);
    process.exit(1);
  }
}

main();
