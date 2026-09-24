import {
  emptyPreparationManifest,
  MAX_PREPARATION_MANIFEST_BYTES,
  parsePreparationManifest,
  PREPARATION_MANIFEST_FILENAME,
  validatePreparationManifest,
  type PreparationJob,
  type PreparationManifest,
} from "../domain/preparation.ts";
import {
  checkAbort,
  isNamedError,
  type DirectoryHandle,
  type FileHandle,
  type WritableHandle,
} from "../storage/handles.ts";
import { readJson, type JsonRead } from "../storage/json-files.ts";
import { withTagReservation } from "./tag-reservation.ts";

export {
  PREPARATION_MANIFEST_FILENAME,
  type PreparationJob,
  type PreparationManifest,
} from "../domain/preparation.ts";

export function readPreparation(
  root: DirectoryHandle,
): Promise<JsonRead<PreparationManifest>> {
  return readJson(
    root,
    PREPARATION_MANIFEST_FILENAME,
    validatePreparationManifest,
    MAX_PREPARATION_MANIFEST_BYTES,
  );
}

async function previousText(
  root: DirectoryHandle,
): Promise<string | undefined> {
  try {
    const file = await (
      await root.getFileHandle(PREPARATION_MANIFEST_FILENAME)
    ).getFile();
    if (file.size > MAX_PREPARATION_MANIFEST_BYTES)
      throw new Error("The preparation manifest is too large.");
    const text = await file.text();
    parsePreparationManifest(text);
    return text;
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) return undefined;
    throw error;
  }
}

async function matches(
  handle: FileHandle,
  previous: string | undefined,
): Promise<boolean> {
  const file = await handle.getFile();
  if (previous === undefined) return file.size === 0;
  return (
    file.size <= MAX_PREPARATION_MANIFEST_BYTES &&
    (await file.text()) === previous
  );
}

function changed(): Error {
  return new Error(
    "Preparation records changed in another session. Try again.",
  );
}

/** Return the jobs to save, or undefined to keep the manifest unchanged. */
export type PreparationChange = (
  jobs: Readonly<Record<string, PreparationJob>>,
) => Record<string, PreparationJob> | undefined;

async function commit(
  root: DirectoryHandle,
  change: PreparationChange,
  signal: AbortSignal | undefined,
  assertOwned: () => Promise<void>,
): Promise<PreparationManifest> {
  checkAbort(signal);
  const previous = await previousText(root);
  const current =
    previous === undefined
      ? emptyPreparationManifest()
      : parsePreparationManifest(previous);
  const jobs = change(current.jobs);
  if (!jobs) {
    await assertOwned();
    return current;
  }
  const next = validatePreparationManifest({
    schemaVersion: 1,
    revision: current.revision + 1,
    jobs,
  });
  const text = JSON.stringify(next, null, 2) + "\n";
  if (
    new TextEncoder().encode(text).byteLength > MAX_PREPARATION_MANIFEST_BYTES
  )
    throw new Error("The preparation manifest is too large.");
  checkAbort(signal);
  const handle = await root.getFileHandle(PREPARATION_MANIFEST_FILENAME, {
    create: true,
  });
  let writer: WritableHandle | undefined;
  let closed = false;
  try {
    writer = await handle.createWritable({ mode: "exclusive" });
    await assertOwned();
    if (!(await matches(handle, previous))) throw changed();
    checkAbort(signal);
    await writer.write(text);
    if (!(await matches(handle, previous))) throw changed();
    await assertOwned();
    await writer.close();
    closed = true;
    return next;
  } finally {
    if (writer && !closed) await writer.abort().catch(() => undefined);
    if (!closed && previous === undefined) {
      try {
        const currentHandle = await root.getFileHandle(
          PREPARATION_MANIFEST_FILENAME,
        );
        if (
          (await currentHandle.isSameEntry(handle)) &&
          (await currentHandle.getFile()).size === 0
        )
          await root.removeEntry(PREPARATION_MANIFEST_FILENAME);
      } catch {
        // Preserve inaccessible or replaced files. The original error remains.
      }
    }
  }
}

let pendingWrite: Promise<unknown> = Promise.resolve();

/** Apply a change under the shared sample-folder manifest reservation. */
export function updatePreparation(
  root: DirectoryHandle,
  change: PreparationChange,
  signal?: AbortSignal,
): Promise<PreparationManifest> {
  const run = async () => {
    checkAbort(signal);
    const locks =
      typeof navigator === "undefined" ? undefined : navigator.locks;
    const operation = () =>
      withTagReservation(
        root,
        (assertOwned) => commit(root, change, signal, assertOwned),
        { signal },
      );
    if (locks?.request)
      return locks.request(
        "ravefold-sample-tags-v1",
        { mode: "exclusive", ...(signal ? { signal } : {}) },
        operation,
      );
    return operation();
  };
  const task = pendingWrite.then(run, run);
  pendingWrite = task.catch(() => undefined);
  return task;
}
