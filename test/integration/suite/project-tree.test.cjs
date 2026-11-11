const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

suite("project ownership through editor commands", () => {
  test("tree mutations keep their project when editor focus changes", async function () {
    this.timeout(60000);
    await vscode.extensions.getExtension("m1-tooling.m1-vscode").activate();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "m1-tree-host-"));
    const originalInput = vscode.window.showInputBox;
    const originalWarning = vscode.window.showWarningMessage;
    const xml =
      '<Project><Component Classname="BuiltIn.GroupCompound" Name="Root"/><Component Classname="BuiltIn.Channel" Name="Root.Signal"><Props Type="f32"/></Component></Project>\n';
    const projects = {};
    const docs = {};
    try {
      for (const name of ["a", "b"]) {
        const dir = path.join(root, name);
        fs.mkdirSync(dir);
        projects[name] = path.join(dir, "Project.m1prj");
        fs.writeFileSync(projects[name], xml);
        const script = path.join(dir, "Main.m1scr");
        fs.writeFileSync(script, "Root.Signal = 1;\n");
        docs[name] = await vscode.workspace.openTextDocument(script);
      }
      const node = { path: "Root.Signal", projectFile: projects.a };
      let answer = "rpm";
      vscode.window.showInputBox = async () => {
        await vscode.window.showTextDocument(docs.b);
        return answer;
      };
      await vscode.window.showTextDocument(docs.b);
      await vscode.commands.executeCommand("m1.projectTree.setUnit", node);
      assert.match(fs.readFileSync(projects.a, "utf8"), /Unit="rpm"/);
      assert.equal(fs.readFileSync(projects.b, "utf8"), xml);

      answer = "Renamed";
      await vscode.commands.executeCommand("m1.projectTree.rename", node);
      assert.match(fs.readFileSync(projects.a, "utf8"), /Name="Root.Renamed"/);
      assert.equal(fs.readFileSync(projects.b, "utf8"), xml);

      let confirmation;
      vscode.window.showWarningMessage = async (message) => {
        confirmation = message;
        await vscode.window.showTextDocument(docs.b);
        return "Delete";
      };
      await vscode.commands.executeCommand("m1.projectTree.delete", {
        path: "Root.Renamed",
        projectFile: projects.a,
      });
      assert(confirmation.includes(projects.a));
      assert.doesNotMatch(fs.readFileSync(projects.a, "utf8"), /Root.Renamed/);
      assert.equal(fs.readFileSync(projects.b, "utf8"), xml);

      // Palette commands capture the active project before showing a prompt.
      const paletteInputs = ["Root.Signal", "kPa"];
      vscode.window.showInputBox = async () => {
        await vscode.window.showTextDocument(docs.a);
        return paletteInputs.shift();
      };
      await vscode.window.showTextDocument(docs.b);
      await vscode.commands.executeCommand("m1.setChannelUnit");
      assert.match(fs.readFileSync(projects.b, "utf8"), /Unit="kPa"/);
      assert.doesNotMatch(fs.readFileSync(projects.a, "utf8"), /kPa/);
    } finally {
      vscode.window.showInputBox = originalInput;
      vscode.window.showWarningMessage = originalWarning;
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
