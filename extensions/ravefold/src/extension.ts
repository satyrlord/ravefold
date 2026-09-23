import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { NativeFiles } from "./native-files.ts";
import {
  NATIVE_CHANNEL,
  NATIVE_VERSION,
  isNativeRequest,
} from "../../../shared/native-protocol.ts";
import type {
  NativeRole,
  NativeRequest,
  NativeResponse,
  NativeHandle,
} from "../../../shared/native-protocol.ts";

const referenceKey = "ravefold.folderReferences.v1";
type SavedReferences = Partial<
  Record<NativeRole, { path: string; identity: string }>
>;

function savedReferences(value: unknown): SavedReferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: SavedReferences = {};
  for (const role of ["samples", "settings"] as const) {
    const reference = source[role];
    if (!reference || typeof reference !== "object" || Array.isArray(reference))
      continue;
    const { path, identity } = reference as Record<string, unknown>;
    if (
      typeof path === "string" &&
      isAbsolute(path) &&
      path.length <= 32767 &&
      typeof identity === "string" &&
      identity.length > 0 &&
      identity.length < 200
    )
      result[role] = { path, identity };
  }
  return result;
}

function safeError(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : "Error";
  const messages: Record<string, string> = {
    AbortError: "Folder selection cancelled.",
    NotAllowedError: "Folder access is unavailable. Select the folder again.",
    NotFoundError: "The selected file or folder is missing.",
    NotReadableError:
      "The file changed or could not be read. Retry the folder check.",
    TypeMismatchError: "The file or folder type is not valid.",
    InvalidModificationError:
      "The file cannot be changed. Check its contents and try again.",
    InvalidStateError:
      "The operation is no longer available. Retry the folder check.",
    QuotaExceededError: "The operation exceeds the current file limit.",
    SecurityError: "The operation is outside the selected folder permissions.",
  };
  return {
    name: name in messages ? name : "Error",
    message:
      messages[name] ?? "The file operation failed. Check folder access.",
  };
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

async function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): Promise<string> {
  const webRoot = vscode.Uri.joinPath(extensionUri, "web");
  const source = await readFile(
    vscode.Uri.joinPath(webRoot, "index.html").fsPath,
    "utf8",
  );
  const html = source.replace(
    /(src|href)="\.\/(assets\/[a-zA-Z0-9_./-]+)"/g,
    (_match, attribute: string, path: string) => {
      if (path.split("/").includes(".."))
        throw new Error("An application asset path is invalid.");
      return `${attribute}="${escapeAttribute(webview.asWebviewUri(vscode.Uri.joinPath(webRoot, path)).toString())}"`;
    },
  );
  const policy = `default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data: blob:; connect-src ${webview.cspSource} https://archive.org https://*.archive.org; worker-src ${webview.cspSource} blob:; base-uri 'none'; form-action 'none'`;
  return html
    .replace('<html lang="en">', '<html lang="en" data-ravefold-native="1">')
    .replace(
      "<head>",
      `<head><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`,
    );
}

export function activate(context: vscode.ExtensionContext): void {
  let panel: vscode.WebviewPanel | undefined;
  let files = new NativeFiles();
  let generation = 0;
  let operations: Promise<unknown> = Promise.resolve();
  let queued = 0;
  const requests = new Set<string>();

  const enqueue = (work: () => Promise<unknown>): Promise<unknown> => {
    const result = operations.then(work);
    operations = result.catch(() => undefined);
    return result;
  };

  const handle = async (
    message: NativeRequest,
    started: number,
  ): Promise<unknown> => {
    if (!vscode.workspace.isTrusted)
      throw new DOMException("Access denied.", "NotAllowedError");
    const currentFiles = files;
    const request = message.request;
    if (request.op === "pickFolder") {
      if (request.kind !== "samples" && request.kind !== "settings")
        throw new DOMException("Invalid role.", "SecurityError");
      const selected = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        title:
          request.kind === "samples"
            ? "Select sample folder"
            : "Select settings folder",
        openLabel: "Use folder",
        ...(request.kind === "settings"
          ? { defaultUri: vscode.Uri.file(join(homedir(), "Documents")) }
          : {}),
      });
      const uri = selected?.[0];
      if (generation !== started)
        throw new DOMException("Session ended.", "AbortError");
      if (!uri) throw new DOMException("Selection cancelled.", "AbortError");
      if (uri.scheme !== "file")
        throw new DOMException("Local folders only.", "NotAllowedError");
      return currentFiles.selectRoot(request.kind, uri.fsPath);
    }
    if (request.op === "loadReferences") {
      const saved = savedReferences(context.globalState.get(referenceKey));
      const restored: Partial<Record<NativeRole, NativeHandle>> = {};
      for (const kind of ["samples", "settings"] as const) {
        if (generation !== started)
          throw new DOMException("Session ended.", "AbortError");
        const reference = saved[kind];
        if (reference) {
          try {
            restored[kind] = await currentFiles.restoreRoot(
              kind,
              reference.path,
              reference.identity,
            );
          } catch {
            /* A missing saved folder requires explicit selection again. */
          }
        }
      }
      return restored;
    }
    if (request.op === "saveReference") {
      if (request.kind !== "samples" && request.kind !== "settings")
        throw new DOMException("Invalid role.", "SecurityError");
      const reference = currentFiles.referenceFor(request.handle);
      if (reference.role !== request.kind)
        throw new DOMException("Invalid folder role.", "SecurityError");
      const saved = savedReferences(context.globalState.get(referenceKey));
      await context.globalState.update(referenceKey, {
        ...saved,
        [request.kind]: { path: reference.path, identity: reference.identity },
      });
      return null;
    }
    return currentFiles.dispatch(request);
  };

  const receive = async (value: unknown, target: vscode.WebviewPanel) => {
    if (
      !isNativeRequest(value) ||
      target !== panel ||
      queued >= 64 ||
      requests.has(value.id)
    )
      return;
    const started = generation;
    requests.add(value.id);
    queued++;
    let response: NativeResponse;
    try {
      const result = await enqueue(async () => {
        if (started !== generation || target !== panel)
          throw new DOMException("Session ended.", "NotAllowedError");
        return handle(value, started);
      });
      response = {
        channel: NATIVE_CHANNEL,
        version: NATIVE_VERSION,
        id: value.id,
        ok: true,
        result: result ?? null,
      };
    } catch (error) {
      response = {
        channel: NATIVE_CHANNEL,
        version: NATIVE_VERSION,
        id: value.id,
        ok: false,
        error: safeError(error),
      };
    } finally {
      queued--;
      requests.delete(value.id);
    }
    if (target === panel && started === generation)
      await target.webview.postMessage(response);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("ravefold.open", async () => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showErrorMessage(
          "RaveFold needs a trusted window for folder access.",
        );
        return;
      }
      if (panel) {
        panel.reveal();
        return;
      }
      const current = vscode.window.createWebviewPanel(
        "ravefold",
        "RaveFold",
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "web"),
          ],
        },
      );
      panel = current;
      current.webview.onDidReceiveMessage(
        (message: unknown) => {
          void receive(message, current);
        },
        undefined,
        context.subscriptions,
      );
      current.onDidDispose(
        () => {
          if (panel === current) panel = undefined;
          generation++;
          const old = files;
          files = new NativeFiles();
          void enqueue(() => old.dispose());
        },
        undefined,
        context.subscriptions,
      );
      try {
        current.webview.html = await webviewHtml(
          current.webview,
          context.extensionUri,
        );
      } catch {
        current.dispose();
        void vscode.window.showErrorMessage(
          "RaveFold application files are unavailable. Install the complete extension package.",
        );
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("ravefold.forgetFolders", async () => {
      generation++;
      await enqueue(async () => {
        await files.dispose();
        files = new NativeFiles();
        await context.globalState.update(referenceKey, undefined);
      });
      await panel?.webview.postMessage({
        channel: NATIVE_CHANNEL,
        version: NATIVE_VERSION,
        event: "revoked",
      });
      void vscode.window.showInformationMessage(
        "Folder references cleared. Your files are unchanged.",
      );
    }),
  );
  context.subscriptions.push({
    dispose: () => {
      generation++;
      panel?.dispose();
      void files.dispose();
    },
  });
}
