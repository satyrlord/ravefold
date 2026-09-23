import { readSourceBytes } from "./analyzer.ts";
import type { PairAudioReply } from "./pair-worker.ts";

type WorkerReply = PairAudioReply | { error: string };

/** Analyze an explicit left/right source choice in a separate Worker. */
export async function analyzePair(
  left: { path: string; file: Blob },
  right: { path: string; file: Blob },
  provenanceId: string,
  signal?: AbortSignal,
  officialSources?: {
    left: { sourceSha256: string; sourceBytes: number };
    right: { sourceSha256: string; sourceBytes: number };
  },
): Promise<PairAudioReply> {
  signal?.throwIfAborted();
  if (typeof Worker !== "function")
    throw new Error("Stereo analysis is unavailable in this browser.");
  const [leftBytes, rightBytes] = await Promise.all([
    readSourceBytes(left.file, signal),
    readSourceBytes(right.file, signal),
  ]);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./pair-worker.ts", import.meta.url), {
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
        reject(new DOMException("Stereo analysis stopped.", "AbortError"));
    };
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (!close()) return;
      if ("error" in event.data) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.onerror = () => {
      if (close()) reject(new Error("The stereo analysis worker stopped."));
    };
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) {
      aborted();
      return;
    }
    try {
      worker.postMessage(
        {
          leftBytes,
          rightBytes,
          leftPath: left.path,
          rightPath: right.path,
          provenanceId,
          officialSources,
        },
        [leftBytes, rightBytes],
      );
    } catch (error) {
      if (close()) reject(error);
    }
  });
}
