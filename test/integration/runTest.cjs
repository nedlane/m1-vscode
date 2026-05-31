// Downloads a real (Linux) VS Code, launches it with this extension loaded, and
// runs the Mocha suite inside the Extension Host. Works under WSLg (DISPLAY set).
const path = require("path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index.cjs");
  const workspace = path.resolve(__dirname, "./fixtures");
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // --no-sandbox is required to run Electron as the dev user under WSLg.
      launchArgs: [workspace, "--no-sandbox", "--disable-gpu"],
    });
  } catch (err) {
    console.error("Integration tests failed:", err);
    process.exit(1);
  }
}

main();
