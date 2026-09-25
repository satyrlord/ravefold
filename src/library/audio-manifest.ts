import {
  AUDIO_MANIFEST_FILENAME,
  emptyAudioManifest,
  MAX_AUDIO_MANIFEST_BYTES,
  parseAudioManifest,
  validateAudioManifest,
  validateAudioRecord,
  type AudioManifest,
  type AudioRecord,
  type CorrectedAudio,
  type DeclaredAudio,
} from "../domain/audio-manifest.ts";
import { validateSamplePath } from "../domain/project.ts";
import { validateWav } from "../domain/wav.ts";
import type { AudioAnalysisReply } from "../audio/analyze-worker.ts";
import {
  checkAbort,
  isNamedError,
  type DirectoryHandle,
  type FileHandle,
  type WritableHandle,
} from "../storage/handles.ts";
import { readJson, type JsonRead } from "../storage/json-files.ts";
import { verifyOfficialSource } from "./source-manifest.ts";
import { withTagReservation } from "./tag-reservation.ts";

export {
  AUDIO_MANIFEST_FILENAME,
  emptyAudioManifest,
  MAX_AUDIO_MANIFEST_BYTES,
  parseAudioManifest,
  validateAudioManifest,
  validateAudioRecord,
  type AudioManifest,
  type AudioRecord,
  type CorrectedAudio,
  type DeclaredAudio,
} from "../domain/audio-manifest.ts";

export type AudioAnalysisSave = AudioAnalysisReply & {
  declared?: DeclaredAudio | null;
  corrected?: CorrectedAudio | null;
};

/** A stored ready result needs fresh source checks before use. */
export function readAudioAnalysis(
  root: DirectoryHandle,
): Promise<JsonRead<AudioManifest>> {
  return readJson(
    root,
    AUDIO_MANIFEST_FILENAME,
    validateAudioManifest,
    MAX_AUDIO_MANIFEST_BYTES,
  );
}

async function previousText(
  root: DirectoryHandle,
): Promise<string | undefined> {
  try {
    const file = await (
      await root.getFileHandle(AUDIO_MANIFEST_FILENAME)
    ).getFile();
    if (file.size > MAX_AUDIO_MANIFEST_BYTES)
      throw new Error("The analysis manifest is too large.");
    const text = await file.text();
    parseAudioManifest(text);
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
    file.size <= MAX_AUDIO_MANIFEST_BYTES && (await file.text()) === previous
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

/** Check the current source before a manifest can claim its analysis. */
async function verifySource(
  root: DirectoryHandle,
  path: string,
  row: AudioRecord,
  signal?: AbortSignal,
): Promise<void> {
  const file = await sourceFile(root, path, signal);
  if (file.size !== row.sourceBytes)
    throw new Error("The sample changed after analysis. Analyze it again.");
  const wav = await validateWav(file, signal);
  if (!wav.valid || JSON.stringify(wav.info) !== JSON.stringify(row.wav))
    throw new Error(
      "The sample format changed after analysis. Analyze it again.",
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
  if (hash !== row.sourceSha256)
    throw new Error("The sample changed after analysis. Analyze it again.");
  if (
    row.measured.measured.sampleKind === "source-backed-compatible-loop" ||
    row.measured.measured.sampleKind === "source-backed-one-shot"
  ) {
    const official = await verifyOfficialSource(root, path, signal);
    if (
      !official.verifiedOfficialSource ||
      official.sourceSha256 !== row.sourceSha256 ||
      official.sourceBytes !== row.sourceBytes
    )
      throw new Error("The source record changed. Analyze this sample again.");
  }
}

function changed(): Error {
  return new Error(
    "Analysis changed in another session. Analyze this sample again.",
  );
}

async function baseline(
  root: DirectoryHandle,
  path: string,
): Promise<AudioRecord | undefined> {
  const read = await readAudioAnalysis(root);
  if (read.status === "missing") return undefined;
  if (read.status !== "valid")
    throw new Error(
      "The existing analysis manifest cannot be replaced. Check folder access and its contents.",
    );
  return read.value.samples[path];
}

async function commitAnalysis(
  root: DirectoryHandle,
  path: string,
  row: AudioRecord,
  expected: AudioRecord | undefined,
  signal: AbortSignal | undefined,
  assertOwned: () => Promise<void>,
): Promise<AudioManifest> {
  checkAbort(signal);
  const previous = await previousText(root);
  const current =
    previous === undefined
      ? emptyAudioManifest()
      : parseAudioManifest(previous);
  const stored = current.samples[path];
  if (JSON.stringify(stored) === JSON.stringify(row)) {
    await verifySource(root, path, row, signal);
    await assertOwned();
    return current;
  }
  if (JSON.stringify(stored) !== JSON.stringify(expected)) throw changed();
  const next = validateAudioManifest({
    ...current,
    revision: current.revision + 1,
    samples: { ...current.samples, [path]: row },
  });
  const text = JSON.stringify(next, null, 2) + "\n";
  if (new TextEncoder().encode(text).byteLength > MAX_AUDIO_MANIFEST_BYTES)
    throw new Error("The analysis manifest is too large.");
  checkAbort(signal);
  const handle = await root.getFileHandle(AUDIO_MANIFEST_FILENAME, {
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
    await verifySource(root, path, row, signal);
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
        const currentHandle = await root.getFileHandle(AUDIO_MANIFEST_FILENAME);
        if (
          (await currentHandle.isSameEntry(handle)) &&
          (await currentHandle.getFile()).size === 0
        )
          await root.removeEntry(AUDIO_MANIFEST_FILENAME);
      } catch {
        // Preserve inaccessible or replaced files. The original error remains.
      }
    }
  }
}

let pendingWrite: Promise<unknown> = Promise.resolve();

/** The tag reservation serializes all sample-folder manifest writes across sessions. */
export function saveAudioAnalysis(
  root: DirectoryHandle,
  path: string,
  result: AudioAnalysisSave,
  signal?: AbortSignal,
): Promise<AudioManifest> {
  const samplePath = validateSamplePath(path);
  const row = validateAudioRecord({
    sourceSha256: result.sourceSha256,
    sourceBytes: result.sourceBytes,
    wav: result.info,
    declared: result.declared ?? null,
    measured: result.analysis,
    corrected: result.corrected ?? null,
    ...(result.reviewed ? { reviewed: result.reviewed } : {}),
  });
  const expectedTask = baseline(root, samplePath);
  void expectedTask.catch(() => undefined);
  const run = async () => {
    checkAbort(signal);
    const expected = await expectedTask;
    const locks =
      typeof navigator === "undefined" ? undefined : navigator.locks;
    const operation = () =>
      withTagReservation(
        root,
        (assertOwned) =>
          commitAnalysis(root, samplePath, row, expected, signal, assertOwned),
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
