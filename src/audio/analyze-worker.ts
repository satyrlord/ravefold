import {
  analyzeRequest,
  type AudioAnalysisReply,
  type AudioAnalysisRequest,
} from "./analyze-request.ts";

export type { AudioAnalysisReply, ReviewRequest } from "./analyze-request.ts";

type WorkerReply = { result: AudioAnalysisReply } | { error: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<AudioAnalysisRequest>) => void) | null;
  postMessage(value: WorkerReply): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = async ({ data }) => {
  try {
    scope.postMessage({ result: await analyzeRequest(data) });
  } catch (error) {
    scope.postMessage({
      error:
        error instanceof Error
          ? error.message
          : "The source audio could not be analyzed.",
    });
  }
};
