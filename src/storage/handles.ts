import { getNativeBridge, nativeBridgeAvailable } from "./native-bridge.ts";

export type FolderKind = "samples" | "settings";
export type AccessState = "granted" | "denied" | "prompt";

export interface HandleBase {
  readonly name: string;
  readonly kind: "file" | "directory";
  isSameEntry(other: HandleBase): Promise<boolean>;
}

export interface WritableHandle {
  write(data: string | Blob | ArrayBuffer | ArrayBufferView): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface FileHandle extends HandleBase {
  readonly kind: "file";
  getFile(): Promise<File>;
  createWritable(options?: {
    keepExistingData?: boolean;
    mode?: "exclusive" | "siloed";
  }): Promise<WritableHandle>;
}

export interface DirectoryHandle extends HandleBase {
  readonly kind: "directory";
  queryPermission(options: { mode: "readwrite" }): Promise<AccessState>;
  requestPermission(options: { mode: "readwrite" }): Promise<AccessState>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileHandle>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<DirectoryHandle>;
  entries(): AsyncIterableIterator<[string, DirectoryHandle | FileHandle]>;
  resolve(handle: HandleBase): Promise<string[] | null>;
  removeEntry(name: string): Promise<void>;
}

interface PickerWindow {
  showDirectoryPicker?: (options: {
    id: string;
    mode: "readwrite";
    startIn?: "documents";
  }) => Promise<DirectoryHandle>;
}

function pickerWindow(): PickerWindow {
  return globalThis as typeof globalThis & PickerWindow;
}

export function pickerAvailable(): boolean {
  return (
    nativeBridgeAvailable() ||
    typeof pickerWindow().showDirectoryPicker === "function"
  );
}

export function isEmbeddedContext(): boolean {
  return typeof window !== "undefined" && window.top !== window.self;
}

export function accessDeniedMessage(): string {
  if (nativeBridgeAvailable())
    return "Folder access is unavailable. Select the folder again.";
  return isEmbeddedContext()
    ? "This browser denied folder access. The host can restrict access in an embedded view. Use the host control to open RaveFold in a Chromium browser window."
    : "Read and write permission is required.";
}

export async function pickFolder(kind: FolderKind): Promise<DirectoryHandle> {
  const native = getNativeBridge();
  if (native) return native.pickFolder(kind);
  const picker = pickerWindow().showDirectoryPicker;
  if (!picker)
    throw new Error("Folder selection is unavailable in this browser.");
  return picker.call(globalThis, {
    id: `ravefold-${kind}`,
    mode: "readwrite",
    ...(kind === "settings" ? { startIn: "documents" as const } : {}),
  });
}

export async function permission(
  handle: DirectoryHandle,
  request = false,
): Promise<AccessState> {
  const state = await handle.queryPermission({ mode: "readwrite" });
  if (state === "granted" || !request) return state;
  return handle.requestPermission({ mode: "readwrite" });
}

export function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export function isNamedError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

export function isCancellation(error: unknown): boolean {
  return isNamedError(error, "AbortError");
}

export function isAccessDenied(error: unknown): boolean {
  return (
    isNamedError(error, "NotAllowedError") ||
    isNamedError(error, "SecurityError")
  );
}

export function isDirectoryHandle(value: unknown): value is DirectoryHandle {
  if (!value || typeof value !== "object") return false;
  const handle = value as Partial<DirectoryHandle>;
  return (
    handle.kind === "directory" &&
    typeof handle.name === "string" &&
    typeof handle.isSameEntry === "function" &&
    typeof handle.queryPermission === "function" &&
    typeof handle.requestPermission === "function" &&
    typeof handle.entries === "function" &&
    typeof handle.getFileHandle === "function" &&
    typeof handle.getDirectoryHandle === "function" &&
    typeof handle.resolve === "function" &&
    typeof handle.removeEntry === "function"
  );
}
