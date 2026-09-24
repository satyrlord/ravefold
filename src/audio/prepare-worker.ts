import {
  prepareAudio,
  type PrepareOutcome,
  type PreparationStage,
} from "./prepare-core.ts";
import type { PreparationPlan } from "../domain/preparation.ts";

export type PrepareWorkerRequest =
  | {
      type: "start";
      bytes: ArrayBuffer;
      sourceSha256: string;
      plan: PreparationPlan;
      paused: boolean;
    }
  | { type: "pause" }
  | { type: "resume" };

export type PrepareWorkerReply =
  | { type: "progress"; stage: PreparationStage; fraction: number }
  | { type: "result"; outcome: PrepareOutcome }
  | { type: "error"; message: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<PrepareWorkerRequest>) => void) | null;
  onunhandledrejection: ((event: PromiseRejectionEvent) => void) | null;
  postMessage(value: PrepareWorkerReply, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;
let paused = false;
let resumeWaiters: Array<() => void> = [];
let lastStage: PreparationStage | undefined;
let lastFraction = -1;
let active = false;

function fail(message: string): void {
  if (!active) return;
  active = false;
  scope.postMessage({ type: "error", message });
}

// The DSP package does not expose its asynchronous initialization rejection.
// This Worker owns one job. Its runner terminates it after a terminal reply.
scope.onunhandledrejection = (event) => {
  event.preventDefault();
  fail("The preparation worker stopped. Retry preparation.");
};

/** Yield so control messages arrive. Wait while playback has priority. */
async function checkpoint(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  while (paused)
    await new Promise<void>((resolve) => resumeWaiters.push(resolve));
}

function progress(stage: PreparationStage, fraction: number): void {
  if (!active) return;
  if (stage === lastStage && fraction - lastFraction < 0.01 && fraction < 1)
    return;
  lastStage = stage;
  lastFraction = fraction;
  scope.postMessage({ type: "progress", stage, fraction });
}

scope.onmessage = async ({ data }) => {
  if (data.type === "pause") {
    paused = true;
    return;
  }
  if (data.type === "resume") {
    paused = false;
    const waiters = resumeWaiters;
    resumeWaiters = [];
    waiters.forEach((resolve) => resolve());
    return;
  }
  if (active) return;
  active = true;
  paused = data.paused;
  try {
    const outcome = await prepareAudio(
      data.bytes,
      data.sourceSha256,
      data.plan,
      {
        progress,
        checkpoint,
      },
    );
    if (!active) return;
    active = false;
    scope.postMessage(
      { type: "result", outcome },
      outcome.status === "validated" ? [outcome.bytes] : [],
    );
  } catch (error) {
    fail(
      error instanceof Error
        ? error.message
        : "The sample could not be prepared.",
    );
  }
};
