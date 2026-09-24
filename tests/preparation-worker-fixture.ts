import { parentPort, workerData } from "node:worker_threads";
import type {
  PrepareWorkerReply,
  PrepareWorkerRequest,
} from "../src/audio/prepare-worker.ts";

const scope = globalThis as unknown as {
  postMessage(reply: PrepareWorkerReply): void;
  onmessage(event: { data: PrepareWorkerRequest }): Promise<void>;
  onunhandledrejection(event: { preventDefault(): void }): void;
};

scope.postMessage = (reply) => parentPort!.postMessage(reply);
// This bridge tests rejection handling after an actual package failure.
// The Chromium suite tests native Worker rejection-event delivery.
process.on("unhandledRejection", () => {
  scope.onunhandledrejection({ preventDefault() {} });
  // A second failure must not send a second terminal reply.
  scope.onunhandledrejection({ preventDefault() {} });
  parentPort!.postMessage({ type: "rejection-handled" });
});
WebAssembly.instantiate = async () => {
  throw new Error("Simulated WASM initialization failure.");
};
await import("../src/audio/prepare-worker.ts");
void scope.onmessage({ data: workerData as PrepareWorkerRequest });
