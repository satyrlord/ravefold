import type { AudioAnalysisReply, ReviewRequest } from "./analyze-worker.ts";
import { MAX_DECODE_WAV_BYTES } from "./pcm.ts";

type WorkerReply = { result: AudioAnalysisReply } | { error: string };

export interface OfficialSourceEvidence {
  sourceSha256: string;
  sourceBytes: number;
}

/** A ready preparation job that produced this exact file. */
export interface PreparedOutputEvidence {
  sha256: string;
  bytes: number;
  expectedBpm: 90 | 180;
  /** The job tempo came from a corrected reading of the same audio. */
  correctedBpm?: 90 | 180;
}

/** Read custom File handles before transfer. Cancellation stops later Worker work. */
export async function readSourceBytes(
  file: Blob,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (file.size > MAX_DECODE_WAV_BYTES)
    throw new Error("Audio analysis supports files up to 100 MiB.");
  const bytes = new Uint8Array(file.size);
  const blockSize = 262_144;
  for (let start = 0; start < bytes.length; start += blockSize) {
    signal?.throwIfAborted();
    const end = Math.min(start + blockSize, bytes.length);
    const block = await file.slice(start, end).arrayBuffer();
    signal?.throwIfAborted();
    if (block.byteLength !== end - start)
      throw new Error("The source audio changed during analysis.");
    bytes.set(new Uint8Array(block), start);
  }
  return bytes.buffer;
}

/** Analyze one source in a Worker. Cancellation stops its CPU work. */
export async function analyzeSource(
  file: Blob,
  signal?: AbortSignal,
  officialSource?: OfficialSourceEvidence,
  preparedOutput?: PreparedOutputEvidence,
  review?: ReviewRequest,
): Promise<AudioAnalysisReply> {
  signal?.throwIfAborted();
  if (typeof Worker !== "function") {
    throw new Error("Audio analysis is unavailable in this browser.");
  }
  const bytes = await readSourceBytes(file, signal);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./analyze-worker.ts", import.meta.url), {
      type: "module",
    });
    let finished = false;
    const close = () => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener("abort", aborted);
      worker.terminate();
      return true;
    };
    const aborted = () => {
      if (close())
        reject(new DOMException("Audio analysis stopped.", "AbortError"));
    };
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (!close()) return;
      if ("result" in event.data) resolve(event.data.result);
      else reject(new Error(event.data.error));
    };
    worker.onerror = () => {
      if (close()) reject(new Error("The audio analysis worker stopped."));
    };
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) {
      aborted();
      return;
    }
    try {
      worker.postMessage({ bytes, officialSource, preparedOutput, review }, [
        bytes,
      ]);
    } catch (error) {
      if (close()) reject(error);
    }
  });
}
