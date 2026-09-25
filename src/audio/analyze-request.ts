import { analyzeAudio, type AudioAnalysis } from "./analyze.ts";
import { decodeWav } from "./pcm.ts";
import type { DeclaredAudio } from "../domain/audio-manifest.ts";
import {
  regionProblem,
  sliceRegion,
  type AnalysisCorrection,
  type SourceRegion,
} from "../domain/review.ts";
import type { WavInfo } from "../domain/wav.ts";

export interface AudioAnalysisReply {
  sourceSha256: string;
  sourceBytes: number;
  info: WavInfo;
  analysis: AudioAnalysis;
  declared?: DeclaredAudio | null;
  /** Validation of review input. Only a review request has it. */
  reviewed?: AudioAnalysis;
}

/** Corrected input for a review. The region uses source frames. */
export interface ReviewRequest {
  region: SourceRegion | null;
  correction?: AnalysisCorrection;
}

export interface AudioAnalysisRequest {
  bytes: ArrayBuffer;
  officialSource?: { sourceSha256: string; sourceBytes: number };
  preparedOutput?: {
    sha256: string;
    bytes: number;
    expectedBpm: 90 | 180;
    correctedBpm?: 90 | 180;
  };
  review?: ReviewRequest;
}

/** Decode and analyze one source. Evidence applies only to the exact bytes. */
export async function analyzeRequest(
  data: AudioAnalysisRequest,
): Promise<AudioAnalysisReply> {
  const file = new Blob([data.bytes]);
  const digest = await crypto.subtle.digest("SHA-256", data.bytes);
  const sourceSha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const verifiedOfficialSource =
    data.officialSource?.sourceSha256 === sourceSha256 &&
    data.officialSource.sourceBytes === data.bytes.byteLength;
  const prepared =
    data.preparedOutput?.sha256 === sourceSha256 &&
    data.preparedOutput.bytes === data.bytes.byteLength
      ? data.preparedOutput
      : undefined;
  const decoded = await decodeWav(file);
  const analysis = analyzeAudio(decoded, {
    ...(verifiedOfficialSource ? { verifiedOfficialSource: true } : {}),
    ...(prepared ? { expectedBpm: prepared.expectedBpm } : {}),
    ...(prepared?.correctedBpm
      ? { correction: { bpm: prepared.correctedBpm } }
      : {}),
  });
  let reviewed: AudioAnalysis | undefined;
  if (data.review) {
    const { region, correction } = data.review;
    if (region) {
      const problem = regionProblem(region, decoded);
      if (problem) throw new Error(problem);
    }
    // Review input replaces the source record as the hypothesis under test.
    reviewed = analyzeAudio(
      region ? sliceRegion(decoded, region) : decoded,
      correction ? { correction } : {},
    );
  }
  const info: WavInfo = {
    encoding: decoded.encoding,
    channels: decoded.channels.length === 2 ? 2 : 1,
    sampleRate: decoded.sampleRate,
    frames: decoded.frames,
    duration: decoded.frames / decoded.sampleRate,
    ...(decoded.loop ? { loop: decoded.loop } : {}),
  };
  return {
    sourceSha256,
    sourceBytes: data.bytes.byteLength,
    info,
    analysis,
    declared: verifiedOfficialSource
      ? { source: "og-collection", bpm: 180, key: "C minor" }
      : null,
    ...(reviewed ? { reviewed } : {}),
  };
}
