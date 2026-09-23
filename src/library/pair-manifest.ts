import {
  emptyPairManifest,
  MAX_PAIR_MANIFEST_BYTES,
  PAIR_MANIFEST_FILENAME,
  pairId,
  parsePairManifest,
  validatePairManifest,
  validatePairRecord,
  type PairManifest,
  type PairRecord,
} from "../domain/pair-manifest.ts";
import { validateWav } from "../domain/wav.ts";
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
  emptyPairManifest,
  MAX_PAIR_MANIFEST_BYTES,
  PAIR_MANIFEST_FILENAME,
  pairId,
  parsePairManifest,
  validatePairManifest,
  validatePairRecord,
  type PairManifest,
  type PairRecord,
  type PairSourceRef,
  type PairProvenance,
} from "../domain/pair-manifest.ts";

export type PairAnalysisSave = Omit<PairRecord, "id">;

async function verifyIds(manifest: PairManifest): Promise<void> {
  for (const [id, row] of Object.entries(manifest.pairs)) {
    if (id !== (await pairId(row.left.path, row.right.path)))
      throw new Error("A pair ID does not match its ordered source paths.");
  }
}

export async function readPairAnalysis(
  root: DirectoryHandle,
): Promise<JsonRead<PairManifest>> {
  const read = await readJson(
    root,
    PAIR_MANIFEST_FILENAME,
    validatePairManifest,
    MAX_PAIR_MANIFEST_BYTES,
  );
  if (read.status !== "valid") return read;
  try {
    await verifyIds(read.value);
    return read;
  } catch (error) {
    return {
      status: "invalid",
      message:
        error instanceof Error ? error.message : "Pair IDs cannot be verified.",
    };
  }
}

async function previousText(
  root: DirectoryHandle,
): Promise<string | undefined> {
  try {
    const file = await (
      await root.getFileHandle(PAIR_MANIFEST_FILENAME)
    ).getFile();
    if (file.size > MAX_PAIR_MANIFEST_BYTES)
      throw new Error("The pair manifest is too large.");
    const text = await file.text();
    await verifyIds(parsePairManifest(text));
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
  return (
    current.size <= MAX_PAIR_MANIFEST_BYTES &&
    (await current.text()) === previous
  );
}

async function sourceFile(
  root: DirectoryHandle,
  path: string,
  signal?: AbortSignal,
): Promise<File> {
  const parts = path.split("/");
  let folder = root;
  for (const part of parts.slice(0, -1)) {
    checkAbort(signal);
    folder = await folder.getDirectoryHandle(part);
  }
  checkAbort(signal);
  return (await folder.getFileHandle(parts.at(-1)!)).getFile();
}

/** Verify the source bytes that the pair Worker measured. */
async function verifySources(
  root: DirectoryHandle,
  row: PairRecord,
  signal?: AbortSignal,
): Promise<void> {
  for (const source of [row.left, row.right]) {
    checkAbort(signal);
    const file = await sourceFile(root, source.path, signal);
    if (file.size !== source.sourceBytes)
      throw new Error(
        "A pair source changed after analysis. Analyze it again.",
      );
    const result = await validateWav(file, signal);
    if (
      !result.valid ||
      JSON.stringify(result.info) !== JSON.stringify(source.wav)
    )
      throw new Error(
        "A pair source format changed after analysis. Analyze it again.",
      );
    checkAbort(signal);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await file.arrayBuffer(),
    );
    checkAbort(signal);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (hash !== source.sourceSha256)
      throw new Error(
        "A pair source changed after analysis. Analyze it again.",
      );
  }
}

function changed(): Error {
  return new Error(
    "Pair metadata changed in another session. Check the pair again.",
  );
}

async function baseline(
  root: DirectoryHandle,
  id: string,
): Promise<PairRecord | undefined> {
  const read = await readPairAnalysis(root);
  if (read.status === "missing") return undefined;
  if (read.status !== "valid")
    throw new Error(
      "The existing pair manifest cannot be replaced. Check its contents.",
    );
  return read.value.pairs[id];
}

async function commitPair(
  root: DirectoryHandle,
  row: PairRecord,
  expected: PairRecord | undefined,
  signal: AbortSignal | undefined,
  assertOwned: () => Promise<void>,
): Promise<PairManifest> {
  checkAbort(signal);
  const previous = await previousText(root);
  const current =
    previous === undefined ? emptyPairManifest() : parsePairManifest(previous);
  const stored = current.pairs[row.id];
  if (JSON.stringify(stored) === JSON.stringify(row)) {
    await verifySources(root, row, signal);
    await assertOwned();
    return current;
  }
  if (JSON.stringify(stored) !== JSON.stringify(expected)) throw changed();
  const next = validatePairManifest({
    ...current,
    revision: current.revision + 1,
    pairs: { ...current.pairs, [row.id]: row },
  });
  const text = JSON.stringify(next, null, 2) + "\n";
  if (new TextEncoder().encode(text).byteLength > MAX_PAIR_MANIFEST_BYTES)
    throw new Error("The pair manifest is too large.");
  checkAbort(signal);
  const handle = await root.getFileHandle(PAIR_MANIFEST_FILENAME, {
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
    await verifySources(root, row, signal);
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
        const currentHandle = await root.getFileHandle(PAIR_MANIFEST_FILENAME);
        if (
          (await currentHandle.isSameEntry(handle)) &&
          (await currentHandle.getFile()).size === 0
        )
          await root.removeEntry(PAIR_MANIFEST_FILENAME);
      } catch {
        // Preserve inaccessible files and the original error.
      }
    }
  }
}

let pendingWrite: Promise<unknown> = Promise.resolve();

/** Save metadata only after the Worker checked both channel files. */
export function savePairAnalysis(
  root: DirectoryHandle,
  input: PairAnalysisSave,
  signal?: AbortSignal,
): Promise<PairManifest> {
  const prepared = pairId(input.left.path, input.right.path).then(
    async (id) => {
      const row = validatePairRecord({
        id,
        left: input.left,
        right: input.right,
        provenance: input.provenance,
        alignment: input.alignment,
        analysis: input.analysis,
      });
      return { row, expected: await baseline(root, id) };
    },
  );
  void prepared.catch(() => undefined);
  const run = async () => {
    checkAbort(signal);
    const { row, expected } = await prepared;
    const operation = () =>
      withTagReservation(
        root,
        (assertOwned) => commitPair(root, row, expected, signal, assertOwned),
        { signal },
      );
    const locks =
      typeof navigator === "undefined" ? undefined : navigator.locks;
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
