import {
  MAX_SOURCE_MANIFEST_BYTES,
  SOURCE_MANIFEST_FILENAME,
  parseSourceManifest,
  validateSourceManifest,
  validateSourceRecord,
  type SourceManifest,
  type SourceRecord,
} from "../domain/source-manifest.ts";
import { validateSamplePath } from "../domain/project.ts";
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
  MAX_SOURCE_MANIFEST_BYTES,
  SOURCE_MANIFEST_FILENAME,
  parseSourceManifest,
  validateSourceManifest,
  validateSourceRecord,
  type SourceManifest,
  type SourceRecord,
} from "../domain/source-manifest.ts";

export type OfficialSourceVerification =
  | {
      verifiedOfficialSource: true;
      declared: { source: "og-collection"; bpm: 180; key: "C minor" };
      sourceSha256: string;
      sourceBytes: number;
    }
  | { verifiedOfficialSource: false };

export function readSourceManifest(
  root: DirectoryHandle,
): Promise<JsonRead<SourceManifest>> {
  return readJson(
    root,
    SOURCE_MANIFEST_FILENAME,
    validateSourceManifest,
    MAX_SOURCE_MANIFEST_BYTES,
  );
}

async function sourceFile(
  root: DirectoryHandle,
  path: string,
  signal?: AbortSignal,
): Promise<File> {
  const segments = path.split("/");
  let folder = root;
  for (const segment of segments.slice(0, -1)) {
    checkAbort(signal);
    folder = await folder.getDirectoryHandle(segment);
  }
  checkAbort(signal);
  return (await folder.getFileHandle(segments.at(-1)!)).getFile();
}

async function sourceHash(file: File, signal?: AbortSignal): Promise<string> {
  checkAbort(signal);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  checkAbort(signal);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Match current bytes to a source record. User attestation is not origin proof. */
export async function verifyOfficialSource(
  root: DirectoryHandle,
  path: string,
  signal?: AbortSignal,
): Promise<OfficialSourceVerification> {
  checkAbort(signal);
  let samplePath: string;
  try {
    samplePath = validateSamplePath(path);
  } catch {
    return { verifiedOfficialSource: false };
  }
  const read = await readSourceManifest(root);
  if (read.status !== "valid") return { verifiedOfficialSource: false };
  const record = read.value.sources[samplePath];
  if (!record) return { verifiedOfficialSource: false };
  try {
    const file = await sourceFile(root, samplePath, signal);
    if (file.size !== record.bytes) return { verifiedOfficialSource: false };
    const hash = await sourceHash(file, signal);
    if (hash !== record.sha256) return { verifiedOfficialSource: false };
    return {
      verifiedOfficialSource: true,
      declared: { source: "og-collection", bpm: 180, key: "C minor" },
      sourceSha256: hash,
      sourceBytes: file.size,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { verifiedOfficialSource: false };
  }
}

export interface ArchiveSourceInput {
  path: string;
  sha256: string;
  bytes: number;
}

function archiveRecords(
  inputs: readonly ArchiveSourceInput[],
): Map<string, SourceRecord> {
  if (inputs.length === 0)
    throw new Error("No archive samples are available for registration.");
  const rows = new Map<string, SourceRecord>();
  for (const input of inputs) {
    const path = validateSamplePath(input.path);
    const record = validateSourceRecord({
      sha256: input.sha256,
      bytes: input.bytes,
      declared: { bpm: 180, key: "C minor" },
      provenance: "og-archive-import",
    });
    const earlier = rows.get(path);
    if (
      earlier &&
      (earlier.sha256 !== record.sha256 || earlier.bytes !== record.bytes)
    )
      throw new Error("Archive samples contain different audio at one path.");
    rows.set(path, record);
  }
  return rows;
}

async function previousText(
  root: DirectoryHandle,
): Promise<string | undefined> {
  try {
    const file = await (
      await root.getFileHandle(SOURCE_MANIFEST_FILENAME)
    ).getFile();
    if (file.size > MAX_SOURCE_MANIFEST_BYTES)
      throw new Error("The source manifest is too large.");
    const text = await file.text();
    parseSourceManifest(text);
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
    file.size <= MAX_SOURCE_MANIFEST_BYTES && (await file.text()) === previous
  );
}

async function verifyArchiveFiles(
  root: DirectoryHandle,
  rows: Map<string, SourceRecord>,
  signal?: AbortSignal,
): Promise<void> {
  for (const [path, expected] of rows) {
    checkAbort(signal);
    const file = await sourceFile(root, path, signal);
    if (
      file.size !== expected.bytes ||
      (await sourceHash(file, signal)) !== expected.sha256
    )
      throw new Error("An archive sample changed before source registration.");
  }
}

function conflict(): Error {
  return new Error(
    "An existing source record has different audio. Keep the current manifest unchanged.",
  );
}

function changed(): Error {
  return new Error(
    "The source manifest changed in another session. Retry the import.",
  );
}

async function commitArchiveSources(
  root: DirectoryHandle,
  rows: Map<string, SourceRecord>,
  signal: AbortSignal | undefined,
  assertOwned: () => Promise<void>,
): Promise<SourceManifest> {
  checkAbort(signal);
  const previous = await previousText(root);
  const current =
    previous === undefined
      ? {
          schemaVersion: 1 as const,
          revision: 0,
          sources: {} as SourceManifest["sources"],
        }
      : parseSourceManifest(previous);
  const sources = { ...current.sources };
  let added = 0;
  for (const [path, row] of rows) {
    const existing = sources[path];
    if (existing) {
      if (existing.sha256 !== row.sha256 || existing.bytes !== row.bytes)
        throw conflict();
    } else {
      sources[path] = row;
      added++;
    }
  }
  if (added === 0) {
    await verifyArchiveFiles(root, rows, signal);
    await assertOwned();
    if (
      previous === undefined ||
      !(await matches(
        await root.getFileHandle(SOURCE_MANIFEST_FILENAME),
        previous,
      ))
    )
      throw changed();
    return current;
  }
  const next = validateSourceManifest({
    schemaVersion: 1,
    revision: current.revision + 1,
    sources,
  });
  const text = JSON.stringify(next, null, 2) + "\n";
  parseSourceManifest(text);
  checkAbort(signal);
  const handle = await root.getFileHandle(SOURCE_MANIFEST_FILENAME, {
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
    await verifyArchiveFiles(root, rows, signal);
    if (!(await matches(handle, previous))) throw changed();
    checkAbort(signal);
    await assertOwned();
    await writer.close();
    closed = true;
    return next;
  } finally {
    if (writer && !closed) await writer.abort().catch(() => undefined);
    if (!closed && previous === undefined) {
      try {
        const currentHandle = await root.getFileHandle(
          SOURCE_MANIFEST_FILENAME,
        );
        if (
          (await currentHandle.isSameEntry(handle)) &&
          (await currentHandle.getFile()).size === 0
        )
          await root.removeEntry(SOURCE_MANIFEST_FILENAME);
      } catch {
        // Preserve inaccessible or replaced files. The original error remains.
      }
    }
  }
}

let pendingWrite: Promise<unknown> = Promise.resolve();

/** Append verified archive records under the shared sample manifest reservation. */
export function saveArchiveSources(
  root: DirectoryHandle,
  inputs: readonly ArchiveSourceInput[],
  signal?: AbortSignal,
): Promise<SourceManifest> {
  const rows = archiveRecords(inputs);
  const run = async () => {
    checkAbort(signal);
    const locks =
      typeof navigator === "undefined" ? undefined : navigator.locks;
    const operation = () =>
      withTagReservation(
        root,
        (assertOwned) => commitArchiveSources(root, rows, signal, assertOwned),
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
