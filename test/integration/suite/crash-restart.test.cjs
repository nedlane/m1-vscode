const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

async function eventually(check, message) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

suite("managed crash recovery", () => {
  test("a closed connection cannot restart an untracked client", async function () {
    this.timeout(60000);
    if (process.platform !== "linux") this.skip();
    const extension = vscode.extensions.getExtension("m1-tooling.m1-vscode");
    const api = await extension.activate();
    const binary = fs.realpathSync(
      vscode.workspace.getConfiguration("m1.server").get("path") ||
        path.join(extension.extensionPath, "server/m1-lsp"),
    );
    // Only this extension host's direct children running the configured binary.
    const servers = () =>
      fs.readdirSync("/proc").flatMap((name) => {
        if (!/^\d+$/.test(name)) return [];
        try {
          const status = fs.readFileSync(`/proc/${name}/status`, "utf8");
          if (Number(status.match(/^PPid:\s+(\d+)/m)?.[1]) !== process.pid)
            return [];
          return fs.realpathSync(`/proc/${name}/exe`) === binary
            ? [Number(name)]
            : [];
        } catch {
          return []; // The child exited during enumeration.
        }
      });
    const originalError = vscode.window.showErrorMessage;
    const messages = [];
    let nested;
    vscode.window.showErrorMessage = async (message) => {
      messages.push(message);
      return undefined;
    };
    try {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand("m1.restartServer");
      await eventually(
        () => api.scopedClientInfo().length === 1 && servers().length === 1,
        "one managed server starts",
      );
      // Exercise an idle connection close, without queued writes forcing shutdown.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const [crashed] = servers();
      process.kill(crashed, "SIGKILL");
      await eventually(
        () => api.scopedClientInfo().length === 0,
        "closed connection retires the client",
      );
      // Allow the library close handler and a recovery heartbeat to settle.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.deepEqual(servers(), [], "no automatic untracked restart");
      assert(
        messages.some((message) => message.includes("stopped unexpectedly")),
      );
      await vscode.commands.executeCommand("m1.restartServer");
      await eventually(
        () => api.scopedClientInfo().length === 1 && servers().length === 1,
        "explicit restart creates one managed replacement",
      );
      assert.notEqual(servers()[0], crashed);
      const document = await vscode.workspace.openTextDocument(
        path.resolve(__dirname, "../fixtures/sample.m1scr"),
      );
      await vscode.window.showTextDocument(document);
      await eventually(async () => {
        const hovers = await vscode.commands.executeCommand(
          "vscode.executeHoverProvider",
          document.uri,
          new vscode.Position(1, 6),
        );
        return hovers?.length === 1;
      }, "one live hover provider after restart");
      nested = fs.mkdtempSync(
        path.join(api.scopedClientInfo()[0].root, "crash-transfer-"),
      );
      const marker = path.join(nested, "Project.m1prj");
      fs.writeFileSync(
        marker,
        '<Project><Component Classname="BuiltIn.GroupCompound" Name="Root"/></Project>',
      );
      const script = path.join(nested, "Main.m1scr");
      fs.writeFileSync(script, "local broken = ;\n");
      const child = await vscode.workspace.openTextDocument(script);
      await vscode.window.showTextDocument(child);
      await eventually(
        () => api.scopedClientInfo().length === 2 && servers().length === 2,
        "marker transfer retains exactly the managed processes",
      );
      await eventually(
        () =>
          vscode.languages
            .getDiagnostics(child.uri)
            .some(
              (diagnostic) =>
                diagnostic.severity === vscode.DiagnosticSeverity.Error,
            ),
        "replacement diagnostics remain live after transfer",
      );
      fs.unlinkSync(marker);
      await eventually(
        () => api.scopedClientInfo().length === 1 && servers().length === 1,
        "marker removal leaves one managed process",
      );
      console.log(
        "managed crash recovery pids",
        JSON.stringify({ crashed, replacement: servers() }),
      );
    } finally {
      vscode.window.showErrorMessage = originalError;
      if (nested) {
        await vscode.commands.executeCommand(
          "workbench.action.closeAllEditors",
        );
        fs.rmSync(nested, { recursive: true, force: true });
      }
    }
  });
});
