import { checkAbort, isNamedError, type DirectoryHandle } from "./handles.ts";
import { readJson } from "./json-files.ts";

export interface RecoveryCandidates<T> {
  valid: Array<{ filename: string; value: T }>;
  invalid: Array<{ filename: string; message: string }>;
  unavailable?: string;
}

export async function readRecoveryCandidates<T>(
  settings: DirectoryHandle,
  validate: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<RecoveryCandidates<T>> {
  const result: RecoveryCandidates<T> = { valid: [], invalid: [] };
  checkAbort(signal);
  let directory: DirectoryHandle;
  try {
    directory = await settings.getDirectoryHandle("recovery");
  } catch (error) {
    checkAbort(signal);
    if (!isNamedError(error, "NotFoundError")) {
      result.unavailable =
        "Recovery copies cannot be read. Check folder access.";
    }
    return result;
  }
  try {
    for await (const [filename, handle] of directory.entries()) {
      checkAbort(signal);
      if (handle.kind !== "file" || !filename.endsWith(".ravefold.json"))
        continue;
      const read = await readJson(directory, filename, validate);
      checkAbort(signal);
      if (read.status === "valid")
        result.valid.push({ filename, value: read.value });
      else if (read.status === "invalid")
        result.invalid.push({ filename, message: read.message });
      else if (read.status === "unavailable")
        result.unavailable =
          "Some recovery copies cannot be read. Check folder access.";
    }
  } catch {
    checkAbort(signal);
    result.unavailable =
      "Some recovery copies cannot be read. Check folder access.";
  }
  result.valid.sort((a, b) => a.filename.localeCompare(b.filename));
  return result;
}
