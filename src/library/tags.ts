import { validateSamplePath } from "../domain/project.ts";
import {
  emptyTagManifest,
  MAX_TAGS_BYTES,
  normalizeTags,
  parseTagManifest,
  TAGS_FILENAME,
  validateTagManifest,
  type TagManifest,
} from "../domain/library-tags.ts";
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
  emptyTagManifest,
  MAX_TAGS_BYTES,
  MAX_SAMPLE_TAGS,
  MAX_TAG_LENGTH,
  normalizeTags,
  parseTagManifest,
  TAGS_FILENAME,
  validateTagManifest,
  type TagManifest,
} from "../domain/library-tags.ts";

export function readTags(
  root: DirectoryHandle,
): Promise<JsonRead<TagManifest>> {
  return readJson(root, TAGS_FILENAME, validateTagManifest, MAX_TAGS_BYTES);
}

export interface TagSaveOptions {
  expectedTags?: readonly string[];
  signal?: AbortSignal;
}

let pendingWrite: Promise<unknown> = Promise.resolve();
const lockName = "ravefold-sample-tags-v1";

function changed(): Error {
  return new Error(
    "Tags changed in another session. Reload the library before you save these tags.",
  );
}

async function previousText(
  root: DirectoryHandle,
): Promise<string | undefined> {
  try {
    const file = await (await root.getFileHandle(TAGS_FILENAME)).getFile();
    if (file.size > MAX_TAGS_BYTES)
      throw new Error("The tag manifest is too large.");
    const text = await file.text();
    parseTagManifest(text);
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
  const current = await handle.getFile();
  if (previous === undefined) return current.size === 0;
  return current.size <= MAX_TAGS_BYTES && (await current.text()) === previous;
}

async function commitTags(
  root: DirectoryHandle,
  path: string,
  tags: string[],
  options: TagSaveOptions,
  assertOwned: () => Promise<void>,
): Promise<TagManifest> {
  checkAbort(options.signal);
  const previous = await previousText(root);
  const current =
    previous === undefined ? emptyTagManifest() : parseTagManifest(previous);
  const expected = normalizeTags(options.expectedTags ?? []);
  if (
    JSON.stringify(current.samples[path]?.tags ?? []) !==
    JSON.stringify(expected)
  )
    throw changed();
  const value = validateTagManifest({
    ...current,
    revision: current.revision + 1,
    samples: { ...current.samples, [path]: { tags } },
  });
  const text = JSON.stringify(value, null, 2) + "\n";
  if (new TextEncoder().encode(text).byteLength > MAX_TAGS_BYTES)
    throw new Error("The tag manifest is too large.");
  checkAbort(options.signal);
  const handle = await root.getFileHandle(TAGS_FILENAME, { create: true });
  let writer: WritableHandle | undefined;
  let closed = false;
  try {
    writer = await handle.createWritable({ mode: "exclusive" });
    await assertOwned();
    if (!(await matches(handle, previous))) throw changed();
    checkAbort(options.signal);
    await writer.write(text);
    checkAbort(options.signal);
    if (!(await matches(handle, previous))) throw changed();
    checkAbort(options.signal);
    await assertOwned();
    await writer.close();
    closed = true;
    return value;
  } finally {
    if (writer && !closed) await writer.abort().catch(() => undefined);
    if (!closed && previous === undefined) {
      try {
        const current = await root.getFileHandle(TAGS_FILENAME);
        if (
          (await current.isSameEntry(handle)) &&
          (await current.getFile()).size === 0
        )
          await root.removeEntry(TAGS_FILENAME);
      } catch {
        // Preserve inaccessible files. The original error remains available.
      }
    }
  }
}

/** Serialize app writes. Check the edited record before merging other records. */
export function saveSampleTags(
  root: DirectoryHandle,
  path: string,
  tags: readonly string[],
  options: TagSaveOptions = {},
): Promise<TagManifest> {
  const samplePath = validateSamplePath(path);
  const normalized = normalizeTags(tags);
  const run = async () => {
    checkAbort(options.signal);
    const locks =
      typeof navigator === "undefined" ? undefined : navigator.locks;
    if (locks?.request) {
      return locks.request(
        lockName,
        {
          mode: "exclusive",
          ...(options.signal ? { signal: options.signal } : {}),
        },
        () =>
          withTagReservation(
            root,
            (assertOwned) =>
              commitTags(root, samplePath, normalized, options, assertOwned),
            options,
          ),
      );
    }
    return withTagReservation(
      root,
      (assertOwned) =>
        commitTags(root, samplePath, normalized, options, assertOwned),
      options,
    );
  };
  const task = pendingWrite.then(run, run);
  pendingWrite = task.catch(() => undefined);
  return task;
}
