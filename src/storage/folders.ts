import { validateWav, type WavInfo } from "../domain/wav.ts";
import {
  accessDeniedMessage,
  checkAbort,
  isCancellation,
  isNamedError,
  permission,
  type DirectoryHandle,
  type FileHandle,
  type FolderKind,
  type WritableHandle,
} from "./handles.ts";

export { pickerAvailable, pickFolder, permission } from "./handles.ts";

export interface SampleFile {
  path: string;
  handle: FileHandle;
  info: WavInfo;
}

export interface DiscoveryResult {
  files: SampleFile[];
  examined: number;
  unsupported: number;
  invalid: number;
  inaccessible: string[];
  complete: boolean;
}

export interface DiscoveryOptions {
  signal?: AbortSignal;
  onProgress?: (result: DiscoveryResult) => void;
}

export interface FolderValidation {
  valid: boolean;
  message: string;
  code?: "permission-denied";
  discovery?: DiscoveryResult;
}

export async function checkFolderSeparation(
  first: DirectoryHandle,
  second: DirectoryHandle,
): Promise<boolean> {
  if (await first.isSameEntry(second)) return false;
  if ((await first.resolve(second)) !== null) return false;
  return (await second.resolve(first)) === null;
}

/** Write only a new probe manifest. Never open an existing file for writing. */
export async function probeWriteAccess(
  directory: DirectoryHandle,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  let name = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    name = `.ravefold-access-${crypto.randomUUID()}.manifest.json`;
    try {
      await directory.getFileHandle(name);
    } catch (error) {
      if (isNamedError(error, "NotFoundError")) break;
      throw error;
    }
    name = "";
  }
  if (!name) throw new Error("A new access manifest could not be created.");
  checkAbort(signal);
  const handle = await directory.getFileHandle(name, { create: true });
  const marker = JSON.stringify({ kind: "ravefold-access-check", name });
  let writer: WritableHandle | undefined;
  let closed = false;
  try {
    if ((await handle.getFile()).size !== 0) {
      throw new Error("The access manifest already contains data.");
    }
    writer = await handle.createWritable({ mode: "exclusive" });
    if ((await handle.getFile()).size !== 0) {
      throw new Error("The access manifest changed during the check.");
    }
    checkAbort(signal);
    await writer.write(marker);
    checkAbort(signal);
    await writer.close();
    closed = true;
    checkAbort(signal);
  } finally {
    if (writer && !closed) await writer.abort().catch(() => undefined);
    try {
      const current = await directory.getFileHandle(name);
      const contents = await current.getFile();
      if (
        (await current.isSameEntry(handle)) &&
        contents.size === marker.length &&
        (await contents.text()) === marker
      ) {
        await directory.removeEntry(name);
      }
    } catch {
      // An inaccessible probe can remain. It contains no audio or user settings.
    }
  }
}

export async function discoverSamples(
  directory: DirectoryHandle,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    files: [],
    examined: 0,
    unsupported: 0,
    invalid: 0,
    inaccessible: [],
    complete: false,
  };
  let reportedFiles = 0;
  let reportedExamined = 0;
  let visited = 0;
  const publish = (force = false) => {
    checkAbort(options.signal);
    if (
      !force &&
      !(reportedFiles === 0 && result.files.length > 0) &&
      result.examined - reportedExamined < 32
    )
      return;
    reportedFiles = result.files.length;
    reportedExamined = result.examined;
    options.onProgress?.({
      ...result,
      files: [...result.files],
      inaccessible: [...result.inaccessible],
    });
  };
  const pending = [{ handle: directory, path: "" }];
  while (pending.length) {
    checkAbort(options.signal);
    const folder = pending.pop()!;
    try {
      for await (const [name, handle] of folder.handle.entries()) {
        visited++;
        if (visited % 32 === 0)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        checkAbort(options.signal);
        const path = folder.path ? `${folder.path}/${name}` : name;
        if (handle.kind === "directory") {
          pending.push({ handle, path });
          continue;
        }
        result.examined++;
        if (!/\.wav$/i.test(name)) {
          result.unsupported++;
          publish();
          continue;
        }
        try {
          const file = await handle.getFile();
          const validation = await validateWav(file, options.signal);
          if (validation.valid) {
            result.files.push({ path, handle, info: validation.info });
          } else {
            result.invalid++;
          }
        } catch (error) {
          if (isCancellation(error) || options.signal?.aborted) throw error;
          result.inaccessible.push(path);
        }
        publish();
      }
    } catch (error) {
      if (isCancellation(error) || options.signal?.aborted || !folder.path) {
        throw error;
      }
      result.inaccessible.push(folder.path);
      publish(true);
    }
  }
  checkAbort(options.signal);
  result.complete = result.inaccessible.length === 0;
  publish(true);
  return result;
}

export async function validateFolder(
  directory: DirectoryHandle,
  kind: FolderKind,
  options: DiscoveryOptions & {
    other?: DirectoryHandle;
    requestPermission?: boolean;
  } = {},
): Promise<FolderValidation> {
  checkAbort(options.signal);
  const access = await permission(directory, options.requestPermission);
  if (access !== "granted") {
    return {
      valid: false,
      message:
        access === "denied"
          ? accessDeniedMessage()
          : "Read and write permission is required.",
      ...(access === "denied" ? { code: "permission-denied" as const } : {}),
    };
  }
  if (
    options.other &&
    !(await checkFolderSeparation(directory, options.other))
  ) {
    return {
      valid: false,
      message: "Select separate folders. Neither folder can contain the other.",
    };
  }
  await probeWriteAccess(directory, options.signal);
  if (kind === "settings") {
    const iterator = directory.entries();
    await iterator.next();
    await iterator.return?.();
    checkAbort(options.signal);
    return { valid: true, message: "Settings folder is ready." };
  }
  const discovery = await discoverSamples(directory, options);
  return {
    valid: discovery.files.length > 0,
    message:
      discovery.files.length === 0
        ? "No supported WAV files were found."
        : discovery.complete
          ? "Sample folder is ready."
          : "Sample folder is ready. Some files could not be examined.",
    discovery,
  };
}
