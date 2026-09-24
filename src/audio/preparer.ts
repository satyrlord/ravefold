import { readSourceBytes } from "./analyzer.ts";
import type { PrepareOutcome, PreparationStage } from "./prepare-core.ts";
import type {
  PrepareWorkerReply,
  PrepareWorkerRequest,
} from "./prepare-worker.ts";
import type { PreparationPlan } from "../domain/preparation.ts";

export interface PreparationRequest {
  file: Blob;
  sourceSha256: string;
  plan: PreparationPlan;
}

export interface PreparationRun {
  signal: AbortSignal;
  onProgress(stage: PreparationStage, fraction: number): void;
}

/** A runner does one resource-intensive job at a time. */
export interface PreparationRunner {
  run(
    request: PreparationRequest,
    run: PreparationRun,
  ): Promise<PrepareOutcome>;
  /** Give playback priority. Work waits between blocks while paused. */
  setPaused(paused: boolean): void;
}

/** Run each job in a new Worker. Cancellation stops the Worker. */
export function workerRunner(): PreparationRunner {
  let paused = false;
  let active: Worker | undefined;
  return {
    setPaused(value) {
      paused = value;
      const message: PrepareWorkerRequest = {
        type: value ? "pause" : "resume",
      };
      active?.postMessage(message);
    },
    async run(request, { signal, onProgress }) {
      signal.throwIfAborted();
      if (typeof Worker !== "function")
        throw new Error("Sample preparation is unavailable in this browser.");
      const bytes = await readSourceBytes(request.file, signal);
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const worker = new Worker(
          new URL("./prepare-worker.ts", import.meta.url),
          { type: "module" },
        );
        active = worker;
        let finished = false;
        const close = () => {
          if (finished) return false;
          finished = true;
          signal.removeEventListener("abort", aborted);
          worker.terminate();
          if (active === worker) active = undefined;
          return true;
        };
        const aborted = () => {
          if (close())
            reject(new DOMException("Preparation stopped.", "AbortError"));
        };
        worker.onmessage = (event: MessageEvent<PrepareWorkerReply>) => {
          const reply = event.data;
          if (reply.type === "progress") {
            if (!finished) onProgress(reply.stage, reply.fraction);
            return;
          }
          // A late reply after cancellation cannot change the job.
          if (!close()) return;
          if (reply.type === "result") resolve(reply.outcome);
          else reject(new Error(reply.message));
        };
        worker.onerror = () => {
          if (close()) reject(new Error("The preparation worker stopped."));
        };
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) {
          aborted();
          return;
        }
        const message: PrepareWorkerRequest = {
          type: "start",
          bytes,
          sourceSha256: request.sourceSha256,
          plan: request.plan,
          paused,
        };
        try {
          worker.postMessage(message, [bytes]);
        } catch (error) {
          if (close()) reject(error);
        }
      });
    },
  };
}
