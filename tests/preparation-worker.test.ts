import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { analyzeAudio } from "../src/audio/analyze.ts";
import type { PrepareWorkerReply } from "../src/audio/prepare-worker.ts";
import { decodeWav } from "../src/audio/pcm.ts";
import { wavInfo } from "../src/audio/prepare-core.ts";
import { planPreparation } from "../src/domain/preparation.ts";
import { NATURAL, phrase, wavFile } from "./audio-signals.ts";

test(
  "WASM initialization rejection sends one normal Worker error",
  { timeout: 10_000 },
  async () => {
    const bytes = wavFile(phrase(135, NATURAL)).buffer;
    const decoded = await decodeWav(new Blob([bytes]));
    const planned = planPreparation(analyzeAudio(decoded), wavInfo(decoded));
    assert.equal(planned.valid, true);
    if (!planned.valid) return;
    const worker = new Worker(
      new URL("./preparation-worker-fixture.ts", import.meta.url),
      {
        workerData: {
          type: "start",
          bytes,
          sourceSha256: createHash("sha256")
            .update(new Uint8Array(bytes))
            .digest("hex"),
          plan: planned.plan,
          paused: false,
        },
        stderr: true,
      },
    );
    try {
      const replies: PrepareWorkerReply[] = [];
      await new Promise<void>((resolve, reject) => {
        worker.on("error", reject);
        worker.on("exit", (code) =>
          reject(new Error(`The Worker exited with code ${code}.`)),
        );
        worker.on(
          "message",
          (reply: PrepareWorkerReply | { type: "rejection-handled" }) => {
            if (reply.type === "rejection-handled") resolve();
            else replies.push(reply);
          },
        );
      });
      assert.deepEqual(
        replies.filter((reply) => reply.type !== "progress"),
        [
          {
            type: "error",
            message: "The preparation worker stopped. Retry preparation.",
          },
        ],
      );
    } finally {
      await worker.terminate();
    }
  },
);
