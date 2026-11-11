import * as vscode from "vscode";

/** Child exit/stderr callbacks can arrive after extension subscriptions close. */
export function createLogChannel(name: string): vscode.LogOutputChannel {
  const raw = vscode.window.createOutputChannel(name, { log: true });
  let disposed = false;
  let lastLevel = raw.logLevel;
  return {
    name: raw.name,
    get logLevel() {
      return disposed ? lastLevel : raw.logLevel;
    },
    onDidChangeLogLevel(listener, thisArgs, disposables) {
      if (!disposed)
        return raw.onDidChangeLogLevel(listener, thisArgs, disposables);
      const subscription = new vscode.Disposable(() => {});
      disposables?.push(subscription);
      return subscription;
    },
    trace(...args) {
      if (!disposed) raw.trace(...args);
    },
    debug(...args) {
      if (!disposed) raw.debug(...args);
    },
    info(...args) {
      if (!disposed) raw.info(...args);
    },
    warn(...args) {
      if (!disposed) raw.warn(...args);
    },
    error(...args) {
      if (!disposed) raw.error(...args);
    },
    append(value) {
      if (!disposed) raw.append(value);
    },
    appendLine(value) {
      if (!disposed) raw.appendLine(value);
    },
    replace(value) {
      if (!disposed) raw.replace(value);
    },
    clear() {
      if (!disposed) raw.clear();
    },
    hide() {
      if (!disposed) raw.hide();
    },
    show(column?: vscode.ViewColumn | boolean, preserveFocus?: boolean) {
      if (disposed) return;
      if (typeof column === "number") raw.show(column, preserveFocus);
      else raw.show(column);
    },
    dispose() {
      if (disposed) return;
      lastLevel = raw.logLevel;
      disposed = true;
      raw.dispose();
    },
  };
}
