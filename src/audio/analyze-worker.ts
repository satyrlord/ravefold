import { analyzeAudio } from "./analyze.ts";
import { decodeWav } from "./pcm.ts";
import type { DeclaredAudio } from "../domain/audio-manifest.ts";
import type { WavInfo } from "../domain/wav.ts";

export interface AudioAnalysisReply {
  sourceSha256: string;
  sourceBytes: number;
  info: WavInfo;
  analysis: ReturnType<typeof analyzeAudio>;
  declared?: DeclaredAudio | null;
}

type WorkerReply = { result: AudioAnalysisReply } | { error: string };

interface WorkerScope {
  onmessage:
    | ((
        event: MessageEvent<{
          bytes: ArrayBuffer;
          officialSource?: { sourceSha256: string; sourceBytes: number };
        }>,
      ) => void)
    | null;
  postMessage(value: WorkerReply): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = async ({ data }) => {
  try {
    const file = new Blob([data.bytes]);
    const digest = await crypto.subtle.digest("SHA-256", data.bytes);
    const sourceSha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const verifiedOfficialSource =
      data.officialSource?.sourceSha256 === sourceSha256 &&
      data.officialSource.sourceBytes === data.bytes.byteLength;
    const decoded = await decodeWav(file);
    const analysis = analyzeAudio(
      decoded,
      verifiedOfficialSource ? { verifiedOfficialSource: true } : undefined,
    );
    const info: WavInfo = {
      encoding: decoded.encoding,
      channels: decoded.channels.length === 2 ? 2 : 1,
      sampleRate: decoded.sampleRate,
      frames: decoded.frames,
      duration: decoded.frames / decoded.sampleRate,
      ...(decoded.loop ? { loop: decoded.loop } : {}),
    };
    scope.postMessage({
      result: {
        sourceSha256,
        sourceBytes: data.bytes.byteLength,
        info,
        analysis,
        declared: verifiedOfficialSource
          ? { source: "og-collection", bpm: 180, key: "C minor" }
          : null,
      },
    });
  } catch (error) {
    scope.postMessage({
      error:
        error instanceof Error
          ? error.message
          : "The source audio could not be analyzed.",
    });
  }
};
