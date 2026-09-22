import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join, relative } from "node:path";
import { runInNewContext } from "node:vm";
import type { NativeResponse } from "../shared/native-protocol.ts";

export async function extensionHarness(
  options: {
    built?: boolean;
    trusted?: boolean;
    saved?: Map<string, unknown>;
  } = {},
) {
  const extensionRoot = resolve("extensions/ravefold");
  const code = options.built
    ? await readFile(join(extensionRoot, "out/extension.cjs"), "utf8")
    : (
        await build({
          entryPoints: [join(extensionRoot, "src/extension.ts")],
          bundle: true,
          write: false,
          platform: "node",
          format: "cjs",
          target: "node22",
          external: ["vscode"],
        })
      ).outputFiles[0]!.text;
  const commands = new Map<string, () => unknown>();
  const saved = options.saved ?? new Map<string, unknown>();
  const notices: string[] = [];
  const pending = new Map<string, (response: NativeResponse) => void>();
  const disposables: Array<{ dispose(): void }> = [];
  let receive: ((value: unknown) => void) | undefined;
  let onDispose = () => {};
  let html = "";
  let closed = false;
  let messageReceiver: ((value: unknown) => void) | undefined;
  const pickerPaths: Array<string | undefined> = [];
  const assetPaths: string[] = [];
  class Uri {
    scheme = "file";
    fsPath: string;
    constructor(path: string) {
      this.fsPath = path;
    }
    static file(path: string) {
      return new Uri(path);
    }
    static joinPath(root: Uri, ...parts: string[]) {
      return new Uri(join(root.fsPath, ...parts));
    }
    toString() {
      return this.fsPath;
    }
  }
  const webview = {
    cspSource: "'self'",
    get html() {
      return html;
    },
    set html(value: string) {
      html = value;
    },
    asWebviewUri(uri: Uri) {
      assetPaths.push(uri.fsPath);
      return {
        toString: () =>
          `http://127.0.0.1:4173/${relative(join(extensionRoot, "web"), uri.fsPath).replaceAll("\\", "/")}`,
      };
    },
    onDidReceiveMessage(listener: (message: unknown) => void) {
      receive = listener;
      return {
        dispose: () => {
          receive = undefined;
        },
      };
    },
    async postMessage(value: unknown) {
      const response = value as NativeResponse;
      pending.get(response.id)?.(response);
      pending.delete(response.id);
      messageReceiver?.(value);
      return true;
    },
  };
  let panelOptions: unknown;
  const panel = {
    webview,
    reveal() {},
    onDidDispose(listener: () => void) {
      onDispose = listener;
      return { dispose() {} };
    },
    dispose() {
      if (!closed) {
        closed = true;
        onDispose();
      }
    },
  };
  const vscode = {
    Uri,
    ViewColumn: { Active: -1 },
    workspace: { isTrusted: options.trusted ?? true },
    commands: {
      registerCommand(name: string, handler: () => unknown) {
        commands.set(name, handler);
        return {
          dispose: () => {
            commands.delete(name);
          },
        };
      },
    },
    window: {
      createWebviewPanel(
        _type: string,
        _name: string,
        _column: number,
        value: unknown,
      ) {
        closed = false;
        panelOptions = value;
        return panel;
      },
      async showOpenDialog() {
        const path = pickerPaths.shift();
        return path ? [Uri.file(path)] : undefined;
      },
      showErrorMessage(message: string) {
        notices.push(message);
      },
      showInformationMessage(message: string) {
        notices.push(message);
      },
    },
  };
  const module = { exports: {} as { activate(context: unknown): void } };
  const require = createRequire(import.meta.url);
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (id: string) => (id === "vscode" ? vscode : require(id)),
    process,
    console,
    Buffer,
    DOMException,
    Error,
    TypeError,
    TextDecoder,
    TextEncoder,
    URL,
    ArrayBuffer,
    Uint8Array,
    setTimeout,
    clearTimeout,
  });
  module.exports.activate({
    extensionUri: Uri.file(extensionRoot),
    subscriptions: disposables,
    globalState: {
      get: (key: string) => saved.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) saved.delete(key);
        else saved.set(key, structuredClone(value));
      },
    },
  });
  return {
    commands,
    saved,
    notices,
    pickerPaths,
    assetPaths,
    vscode,
    html: () => html,
    panelOptions: () => panelOptions,
    async command(name: string) {
      return commands.get(name)?.();
    },
    post(message: unknown) {
      receive?.(message);
    },
    send(message: unknown) {
      return new Promise<NativeResponse>((resolve, reject) => {
        const id = (message as { id: string }).id;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("The extension did not reply."));
        }, 5000);
        pending.set(id, (reply) => {
          clearTimeout(timer);
          resolve(reply);
        });
        receive?.(message);
      });
    },
    messages(callback: (message: unknown) => void) {
      messageReceiver = callback;
    },
    close() {
      panel.dispose();
    },
    dispose() {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
