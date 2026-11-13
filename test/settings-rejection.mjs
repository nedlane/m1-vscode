import assert from "node:assert/strict";
import { build } from "esbuild";
const { outputFiles } = await build({
  entryPoints: ["src/settings-sync.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { pushSettingsToClients } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);
const failures = [],
  sent = [],
  unhandled = [];
const onUnhandled = (error) => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
try {
  const clients = [
    {
      client: {
        sendNotification() {
          throw new Error("stopped");
        },
      },
    },
    {
      client: {
        sendNotification() {
          return Promise.reject(new Error("closed"));
        },
      },
    },
    {
      client: {
        sendNotification(method, payload) {
          sent.push({ method, payload });
        },
      },
    },
  ];
  const settings = { lint: { max_line_length: 80 } };
  const attempts = pushSettingsToClients(clients, settings, (error) =>
    failures.push(error.message),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 3);
  assert.deepEqual(failures.sort(), ["closed", "stopped"]);
  assert.deepEqual(sent, [
    { method: "workspace/didChangeConfiguration", payload: { settings } },
  ]);
  assert.deepEqual(unhandled, []);
  console.log(
    "settings rejection is reported and healthy clients still receive updates",
  );
} finally {
  process.removeListener("unhandledRejection", onUnhandled);
}
