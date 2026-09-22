import {
  checkAbort,
  isNamedError,
  type DirectoryHandle,
  type WritableHandle,
} from "./handles.ts";
import { MAX_PROJECT_BYTES } from "../domain/project.ts";
import { MAX_SETTINGS_BYTES } from "../domain/settings.ts";

export const SETTINGS_FILENAME = "ravefold-settings.json";

export type JsonRead<T> =
  | { status: "missing" }
  | { status: "valid"; value: T }
  | { status: "invalid"; message: string }
  | { status: "unavailable"; message: string };

export function metadataError(error: unknown): string {
  return error instanceof Error ? error.message : "The file could not be read.";
}

export async function readJson<T>(
  directory: DirectoryHandle,
  name: string,
  validate: (value: unknown) => T,
  maxBytes = MAX_PROJECT_BYTES,
): Promise<JsonRead<T>> {
  let file: File;
  try {
    file = await (await directory.getFileHandle(name)).getFile();
  } catch (error) {
    return isNamedError(error, "NotFoundError")
      ? { status: "missing" }
      : {
          status: "unavailable",
          message: "The file cannot be read. Check folder access.",
        };
  }
  if (file.size > maxBytes) {
    return { status: "invalid", message: "The metadata file is too large." };
  }
  let source: string;
  try {
    source = await file.text();
  } catch {
    return {
      status: "unavailable",
      message: "The file cannot be read. Check folder access.",
    };
  }
  try {
    return { status: "valid", value: validate(JSON.parse(source)) };
  } catch (error) {
    return {
      status: "invalid",
      message:
        error instanceof SyntaxError
          ? "The metadata file does not contain valid JSON."
          : metadataError(error),
    };
  }
}

/** Settings are the only mutable user document in this slice. */
export async function writeValidatedJson<T>(
  directory: DirectoryHandle,
  name: string,
  value: T,
  validate: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<void> {
  if (name !== SETTINGS_FILENAME) {
    throw new Error("This write is limited to the settings file.");
  }
  checkAbort(signal);
  const text = JSON.stringify(validate(value), null, 2) + "\n";
  if (new TextEncoder().encode(text).byteLength > MAX_SETTINGS_BYTES) {
    throw new Error("The settings file is too large.");
  }
  let previous: string | undefined;
  try {
    const existing = await (await directory.getFileHandle(name)).getFile();
    if (existing.size > MAX_SETTINGS_BYTES)
      throw new Error("The settings file is too large.");
    previous = await existing.text();
    validate(JSON.parse(previous));
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) {
      throw new Error(
        "Existing settings cannot be replaced. Check the file and folder access.",
      );
    }
  }
  checkAbort(signal);
  const handle = await directory.getFileHandle(name, { create: true });
  let writer: WritableHandle | undefined;
  let closed = false;
  try {
    writer = await handle.createWritable({ mode: "exclusive" });
    const current = await handle.getFile();
    if (
      (previous === undefined && current.size !== 0) ||
      (previous !== undefined && (await current.text()) !== previous)
    ) {
      throw new Error(
        "Settings changed in another session. Read them again before saving.",
      );
    }
    checkAbort(signal);
    await writer.write(text);
    checkAbort(signal);
    await writer.close();
    closed = true;
  } finally {
    if (writer && !closed) await writer.abort().catch(() => undefined);
    if (!closed && previous === undefined) {
      try {
        const current = await directory.getFileHandle(name);
        if (
          (await current.isSameEntry(handle)) &&
          (await current.getFile()).size === 0
        ) {
          await directory.removeEntry(name);
        }
      } catch {
        // Preserve inaccessible or replaced files. The original write error remains.
      }
    }
  }
}
