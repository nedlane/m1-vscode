// #120: the onDidChangeConfiguration handler forwards edited m1.* settings to
// running LSP clients via `workspace/didChangeConfiguration`. settings-surface
// checks key/buildSettings() parity and lsp-smoke checks capabilities, but
// neither confirms a settings change actually reaches a server. Here we drive
// the extension's exported propagation primitives with a MOCK client and assert
// the notification method + payload, plus which config sections trigger a push.
const assert = require("assert");
const vscode = require("vscode");

const EXT_ID = "m1-tooling.m1-vscode";

suite("live settings propagation (#120)", () => {
  let api;

  suiteSetup(async function () {
    this.timeout(60000);
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} should be present`);
    api = await ext.activate();
    assert.ok(api, "activate() should return the test API");
  });

  test("only m1.lint/format/diagnostics changes trigger a push", () => {
    const evt = (...affected) => ({
      affectsConfiguration: (s) => affected.includes(s),
    });
    assert.strictEqual(api.affectsM1Settings(evt("m1.lint")), true);
    assert.strictEqual(api.affectsM1Settings(evt("m1.format")), true);
    assert.strictEqual(api.affectsM1Settings(evt("m1.diagnostics")), true);
    // Unrelated sections (and the bare "m1" root) must not trigger a push.
    assert.strictEqual(api.affectsM1Settings(evt("editor.fontSize")), false);
    assert.strictEqual(api.affectsM1Settings(evt("m1.trace")), false);
    assert.strictEqual(api.affectsM1Settings(evt()), false);
  });

  test("a settings change sends didChangeConfiguration with the {settings} payload", () => {
    const sent = [];
    const mockClient = {
      client: {
        sendNotification: (method, params) => sent.push({ method, params }),
      },
    };
    const settings = { "lint.maxLineLength": 120, "format.indentStyle": "tab" };

    const n = api.pushSettingsToClients([mockClient], settings);

    assert.strictEqual(n, 1, "exactly one client should be notified");
    assert.strictEqual(sent.length, 1, "sendNotification called once");
    assert.strictEqual(sent[0].method, api.didChangeConfigurationMethod);
    assert.strictEqual(
      sent[0].method,
      "workspace/didChangeConfiguration",
      "uses the LSP didChangeConfiguration method",
    );
    assert.deepStrictEqual(
      sent[0].params,
      { settings },
      "payload wraps the built settings under `settings`",
    );
  });

  test("every running client is notified (multi-server workspaces)", () => {
    const calls = [];
    const mk = (id) => ({
      client: { sendNotification: (m, p) => calls.push({ id, m, p }) },
    });
    const settings = { "lint.maxNestingDepth": 5 };

    const n = api.pushSettingsToClients([mk("a"), mk("b"), mk("c")], settings);

    assert.strictEqual(n, 3, "all three clients notified");
    assert.deepStrictEqual(
      calls.map((c) => c.id).sort(),
      ["a", "b", "c"],
      "each client received the notification exactly once",
    );
    for (const c of calls) {
      assert.strictEqual(c.m, "workspace/didChangeConfiguration");
      assert.deepStrictEqual(c.p, { settings });
    }
  });

  test("no running clients is a no-op (no throw)", () => {
    assert.strictEqual(api.pushSettingsToClients([], { x: 1 }), 0);
  });
});
