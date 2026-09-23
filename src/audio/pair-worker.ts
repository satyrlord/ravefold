import { analyzeAudio, type AudioAnalysis } from "./analyze.ts";
import { decodeWav } from "./pcm.ts";
import {
  validateStereoPair,
  type StereoPairValidation,
} from "../domain/stereo-pair.ts";
import type { WavInfo } from "../domain/wav.ts";

interface PairSourceResult {
  path: string;
  sourceSha256: string;
  sourceBytes: number;
  wav: WavInfo;
}

export type PairAudioReply =
  | { valid: false; reason: string }
  | {
      valid: true;
      left: PairSourceResult;
      right: PairSourceResult;
      provenance: { kind: "user-selected"; id: string };
      alignment: Extract<StereoPairValidation, { valid: true }>;
      analysis: AudioAnalysis;
    };

interface PairRequest {
  leftBytes: ArrayBuffer;
  rightBytes: ArrayBuffer;
  leftPath: string;
  rightPath: string;
  provenanceId: string;
  officialSources?: {
    left: { sourceSha256: string; sourceBytes: number };
    right: { sourceSha256: string; sourceBytes: number };
  };
}

type WorkerReply = PairAudioReply | { error: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<PairRequest>) => void) | null;
  postMessage(value: WorkerReply): void;
}

const scope = globalThis as unknown as WorkerScope;

async function hash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function info(decoded: Awaited<ReturnType<typeof decodeWav>>): WavInfo {
  return {
    encoding: decoded.encoding,
    channels: decoded.channels.length === 2 ? 2 : 1,
    sampleRate: decoded.sampleRate,
    frames: decoded.frames,
    duration: decoded.frames / decoded.sampleRate,
    ...(decoded.loop ? { loop: decoded.loop } : {}),
  };
}

scope.onmessage = async ({ data }) => {
  try {
    const left = new Blob([data.leftBytes]);
    const right = new Blob([data.rightBytes]);
    const [leftHash, rightHash] = await Promise.all([
      hash(data.leftBytes),
      hash(data.rightBytes),
    ]);
    const verifiedOfficialSource =
      data.officialSources?.left.sourceSha256 === leftHash &&
      data.officialSources.left.sourceBytes === data.leftBytes.byteLength &&
      data.officialSources.right.sourceSha256 === rightHash &&
      data.officialSources.right.sourceBytes === data.rightBytes.byteLength;
    const alignment = await validateStereoPair(
      { path: data.leftPath, file: left },
      { path: data.rightPath, file: right },
      {
        provenanceId: data.provenanceId,
        channelOrder: "left-right",
        frameOffset: 0,
        left: { path: data.leftPath, sha256: leftHash },
        right: { path: data.rightPath, sha256: rightHash },
      },
    );
    if (!alignment.valid) {
      scope.postMessage(alignment);
      return;
    }
    const [leftDecoded, rightDecoded] = await Promise.all([
      decodeWav(left),
      decodeWav(right),
    ]);
    const analysis = analyzeAudio(
      {
        ...leftDecoded,
        channels: [leftDecoded.channels[0]!, rightDecoded.channels[0]!],
      },
      verifiedOfficialSource ? { verifiedOfficialSource: true } : undefined,
    );
    scope.postMessage({
      valid: true,
      left: {
        path: data.leftPath,
        sourceSha256: leftHash,
        sourceBytes: data.leftBytes.byteLength,
        wav: info(leftDecoded),
      },
      right: {
        path: data.rightPath,
        sourceSha256: rightHash,
        sourceBytes: data.rightBytes.byteLength,
        wav: info(rightDecoded),
      },
      provenance: { kind: "user-selected", id: data.provenanceId },
      alignment,
      analysis,
    });
  } catch (error) {
    scope.postMessage({
      error:
        error instanceof Error
          ? error.message
          : "The stereo pair could not be analyzed.",
    });
  }
};
