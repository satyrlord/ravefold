import { validateWav } from "../domain/wav.ts";
import { checkAbort, isNamedError } from "../storage/handles.ts";
import type { DirectoryHandle, FileHandle } from "../storage/handles.ts";

const ARCHIVE_CONTENTS =
  "https://archive.org/download/raveejay_202005/raveejay.iso/";
const MEMBER_PATH = "/download/raveejay_202005/raveejay.iso/";
const OUTPUT_FOLDER = "Rave eJay ISO";
const MAX_LISTING_LENGTH = 2_000_000;
const MAX_MEMBER_BYTES = 64 * 1024 * 1024;

export interface ArchiveMember {
  path: string;
  url: string;
  size: number;
}

export interface ImportProgress {
  completed: number;
  total: number;
}

function safeMemberPath(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.length >= 2 &&
    parts.every(
      (part) =>
        part !== "." &&
        part !== ".." &&
        /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/u.test(part) &&
        !/[. ]$/u.test(part),
    ) &&
    /\.pxd$/iu.test(parts.at(-1)!)
  );
}

/** Read only PXD entries from the Internet Archive ISO contents page. */
export function parseArchiveContents(html: string): ArchiveMember[] {
  if (html.length > MAX_LISTING_LENGTH)
    throw new Error("The archive file list is too large.");
  const document = new DOMParser().parseFromString(html, "text/html");
  const members: ArchiveMember[] = [];
  const seen = new Set<string>();
  for (const link of document.querySelectorAll<HTMLAnchorElement>(
    "tr a[href]",
  )) {
    const url = new URL(link.getAttribute("href")!, ARCHIVE_CONTENTS);
    if (url.origin !== "https://archive.org") continue;
    if (!url.pathname.startsWith(MEMBER_PATH)) continue;
    let path: string;
    try {
      path = decodeURIComponent(url.pathname.slice(MEMBER_PATH.length));
    } catch {
      continue;
    }
    if (!safeMemberPath(path)) continue;
    if (link.textContent?.trim() !== path) continue;
    const sizeText = link
      .closest("tr")
      ?.querySelector("td[id='size']")?.textContent;
    const size = Number(sizeText?.trim());
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_MEMBER_BYTES)
      throw new Error("The archive file list has an invalid sample size.");
    const key = path.toLowerCase();
    if (seen.has(key))
      throw new Error("The archive file list has duplicate sample names.");
    seen.add(key);
    members.push({ path, url: url.href, size });
  }
  if (members.length === 0)
    throw new Error("The archive contains no PXD samples.");
  return members.sort((first, second) => first.path.localeCompare(second.path));
}

export async function listArchiveMembers(
  signal: AbortSignal,
): Promise<ArchiveMember[]> {
  const response = await fetch(ARCHIVE_CONTENTS, {
    signal,
    credentials: "omit",
  });
  if (!response.ok) throw new Error("The archive file list is unavailable.");
  const bytes = await readBounded(response, MAX_LISTING_LENGTH, signal);
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  checkAbort(signal);
  return parseArchiveContents(html);
}

async function readBounded(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximum)
    throw new Error("The archive response is too large.");
  if (!response.body) throw new Error("The archive response cannot be read.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      checkAbort(signal);
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximum)
        throw new Error("The archive response is too large.");
      chunks.push(result.value);
    }
    complete = true;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function memberBytes(member: ArchiveMember, signal: AbortSignal) {
  const response = await fetch(member.url, { signal, credentials: "omit" });
  if (!response.ok) throw new Error("The archive sample download failed.");
  const bytes = await readBounded(response, member.size, signal);
  checkAbort(signal);
  if (bytes.byteLength !== member.size)
    throw new Error("The archive sample download is incomplete.");
  return bytes;
}

interface DecodeRequest {
  id: number;
  bytes: ArrayBuffer;
}
interface DecodeReply {
  id: number;
  wav?: ArrayBuffer;
  error?: string;
}

class PxdDecoder {
  private worker = new Worker(new URL("./pxd-worker.ts", import.meta.url), {
    type: "module",
  });
  private nextId = 0;
  private closed = false;
  private pending = new Map<
    number,
    {
      resolve: (wav: Uint8Array<ArrayBuffer>) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<DecodeReply>) => {
      const reply = event.data;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.wav) pending.resolve(new Uint8Array(reply.wav));
      else pending.reject(new Error(reply.error ?? "PXD conversion failed."));
    };
    this.worker.onerror = () => {
      this.stop(new Error("PXD conversion stopped."));
    };
  }

  decode(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    if (this.closed)
      return Promise.reject(new Error("PXD conversion stopped."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: DecodeRequest = { id, bytes: bytes.buffer };
      try {
        this.worker.postMessage(request, [request.bytes]);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  stop(reason = new Error("PXD conversion stopped.")): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }
}

async function sameBytes(
  file: File,
  expected: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<boolean> {
  if (file.size !== expected.byteLength) return false;
  const blockSize = 262_144;
  for (let start = 0; start < expected.byteLength; start += blockSize) {
    checkAbort(signal);
    const actual = new Uint8Array(
      await file.slice(start, start + blockSize).arrayBuffer(),
    );
    for (let index = 0; index < actual.length; index++) {
      if (actual[index] !== expected[start + index]) return false;
    }
  }
  return true;
}

async function findExisting(
  directory: DirectoryHandle,
  name: string,
): Promise<FileHandle | undefined> {
  try {
    return await directory.getFileHandle(name);
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) return undefined;
    throw error;
  }
}

async function writeWav(
  directory: DirectoryHandle,
  name: string,
  wav: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<void> {
  const stem = name.slice(0, -4);
  let outputName = "";
  for (let attempt = 1; attempt <= 100; attempt++) {
    checkAbort(signal);
    const candidate = attempt === 1 ? name : `${stem} (${attempt}).wav`;
    const existing = await findExisting(directory, candidate);
    if (!existing) {
      outputName = candidate;
      break;
    }
    const file = await existing.getFile();
    if (await sameBytes(file, wav, signal)) return;
    if (attempt === 1 && file.size > 0)
      throw new Error(`${name} already exists with different audio.`);
  }
  if (!outputName)
    throw new Error(`No unused file name is available for ${name}.`);
  checkAbort(signal);
  const handle = await directory.getFileHandle(outputName, { create: true });
  const created = await handle.getFile();
  if (created.size !== 0)
    throw new Error(`${outputName} changed before the new sample was written.`);
  const writer = await handle.createWritable({ mode: "exclusive" });
  let closed = false;
  try {
    checkAbort(signal);
    await writer.write(wav, signal);
    checkAbort(signal);
    await writer.close();
    closed = true;
    if (!(await sameBytes(await handle.getFile(), wav, signal)))
      throw new Error(`${outputName} could not be verified after writing.`);
  } finally {
    if (!closed) await writer.abort().catch(() => undefined);
  }
}

async function outputDirectory(
  root: DirectoryHandle,
  member: ArchiveMember,
): Promise<{ directory: DirectoryHandle; name: string }> {
  const parts = member.path.split("/");
  const stem = parts.pop()!.replace(/\.pxd$/iu, ".wav");
  let directory = await root.getDirectoryHandle(OUTPUT_FOLDER, {
    create: true,
  });
  for (const part of parts)
    directory = await directory.getDirectoryHandle(part, { create: true });
  return { directory, name: stem };
}

export async function importArchiveSamples(
  root: DirectoryHandle,
  members: readonly ArchiveMember[],
  signal: AbortSignal,
  onProgress: (progress: ImportProgress) => void,
): Promise<void> {
  const decoder = new PxdDecoder();
  const task = new AbortController();
  const stop = () => task.abort();
  const stopDecoder = () =>
    decoder.stop(new DOMException("Import stopped.", "AbortError"));
  signal.addEventListener("abort", stop, { once: true });
  task.signal.addEventListener("abort", stopDecoder, { once: true });
  if (signal.aborted) stop();
  let next = 0;
  let completed = 0;
  let failure: Error | undefined;
  try {
    const run = async () => {
      while (!task.signal.aborted && next < members.length) {
        checkAbort(task.signal);
        const member = members[next++]!;
        try {
          const pxd = await memberBytes(member, task.signal);
          const wav = await decoder.decode(pxd);
          checkAbort(task.signal);
          if (!(await validateWav(new Blob([wav]), task.signal)).valid)
            throw new Error("Conversion produced an invalid WAV file.");
          const output = await outputDirectory(root, member);
          await writeWav(output.directory, output.name, wav, task.signal);
          completed++;
          onProgress({ completed, total: members.length });
        } catch (error) {
          if (!task.signal.aborted) {
            failure = new Error(
              `Could not import ${member.path}: ${error instanceof Error ? error.message : "Unknown error."}`,
            );
            task.abort();
          }
          throw error;
        }
      }
    };
    const tasks = Array.from({ length: Math.min(3, members.length) }, run);
    await Promise.allSettled(tasks);
    if (failure) throw failure;
    checkAbort(signal);
  } finally {
    signal.removeEventListener("abort", stop);
    task.signal.removeEventListener("abort", stopDecoder);
    decoder.stop();
  }
}
