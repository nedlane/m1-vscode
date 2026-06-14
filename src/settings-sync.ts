// Pure, vscode-free helpers for the live-settings propagation handler in
// extension.ts (#120). Extracted here so the decision to forward and the
// notification payload can be unit-tested with a mock client, without standing
// up an Extension Host. extension.ts wires `onDidChangeConfiguration` to these.

/** Minimal shape of the `onDidChangeConfiguration` event we depend on. */
export interface ConfigChangeLike {
  affectsConfiguration(section: string): boolean;
}

/** The `m1.*` configuration sections whose edits must reach running servers. */
export const WATCHED_SECTIONS = [
  "m1.lint",
  "m1.format",
  "m1.diagnostics",
] as const;

/** True when a configuration change touches any watched `m1.*` section. */
export function affectsM1Settings(e: ConfigChangeLike): boolean {
  return WATCHED_SECTIONS.some((s) => e.affectsConfiguration(s));
}

/** Minimal shape of an LSP client we notify. */
export interface NotifiableClient {
  sendNotification(method: string, params: unknown): unknown;
}

/** The LSP method used to push workspace configuration to a server. */
export const DID_CHANGE_CONFIGURATION = "workspace/didChangeConfiguration";

/**
 * Push `settings` to every managed client via
 * `workspace/didChangeConfiguration`, wrapped as `{ settings }`. Returns the
 * number of clients notified (0 when none are running).
 */
export function pushSettingsToClients(
  managed: Iterable<{ client: NotifiableClient }>,
  settings: unknown,
): number {
  let notified = 0;
  for (const { client } of managed) {
    void client.sendNotification(DID_CHANGE_CONFIGURATION, { settings });
    notified += 1;
  }
  return notified;
}
