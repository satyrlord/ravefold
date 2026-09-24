import { analyzeAudio, type AudioAnalysis } from "./analyze.ts";
import { decodeWav, type DecodedWav } from "./pcm.ts";
import { stretchAudio } from "./stretch.ts";
import { encodeFloatWav } from "./wav-encode.ts";
import {
  planPreparation,
  type PreparationMeasurements,
  type PreparationPlan,
} from "../domain/preparation.ts";
import type { WavInfo } from "../domain/wav.ts";

/** A peak above +12 dBFS shows a processing fault, not source audio. */
export const MAX_OUTPUT_PEAK = 4;

export type PreparationStage = "analysis" | "conversion" | "validation";

export interface PrepareControl {
  progress(stage: PreparationStage, fraction: number): void;
  /** Reject to stop. Wait while playback has priority. */
  checkpoint(): Promise<void>;
}

export type PrepareOutcome =
  | {
      status: "validated";
      bytes: ArrayBuffer;
      sha256: string;
      info: WavInfo;
      analysis: AudioAnalysis;
      measurements: PreparationMeasurements;
    }
  | { status: "review"; reasons: string[] };

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function wavInfo(decoded: DecodedWav): WavInfo {
  return {
    encoding: decoded.encoding,
    channels: decoded.channels.length === 2 ? 2 : 1,
    sampleRate: decoded.sampleRate,
    frames: decoded.frames,
    duration: decoded.frames / decoded.sampleRate,
    ...(decoded.loop ? { loop: decoded.loop } : {}),
  };
}

/** The detector can omit rare notes. It must not measure a note outside the job. */
function withinExpected(
  measured: readonly number[] | undefined,
  expected: readonly number[] | null,
): boolean {
  return Boolean(
    measured?.length &&
    measured.every((value) => expected?.includes(value) ?? false),
  );
}

/** Compare a measured output with the job. Each rule is independent. */
function outputReasons(
  plan: PreparationPlan,
  output: DecodedWav,
  analysis: AudioAnalysis,
): string[] {
  const reasons: string[] = [];
  const measured = analysis.measured;
  if (
    output.frames !== plan.outputFrames ||
    output.sampleRate !== plan.sampleRate ||
    output.channels.length !== plan.channels
  )
    reasons.push("The prepared length or channel layout is incorrect.");
  if (analysis.status !== "ready")
    reasons.push(`Output analysis: ${analysis.reasons.join(" ")}`);
  else if (
    measured.bpm !== plan.targetBpm ||
    measured.beatCount !== plan.beatCount
  )
    reasons.push(
      "The prepared tempo or beat count does not agree with the job.",
    );
  if (plan.sampleKind === "key-neutral-loop") {
    if (
      analysis.status === "ready" &&
      measured.sampleKind !== "key-neutral-loop"
    )
      reasons.push("The prepared loop is not measured as key-neutral.");
  } else if (
    analysis.status === "ready" &&
    ((measured.sampleKind !== "tonal-loop" &&
      measured.sampleKind !== "tuned-percussion") ||
      !withinExpected(
        measured.compatiblePitchClasses,
        plan.expectedPitchClasses,
      ))
  )
    reasons.push("The prepared notes do not agree with the expected pitch.");
  return reasons;
}

/** Convert and validate one source. The caller writes a validated result. */
export async function prepareAudio(
  bytes: ArrayBuffer,
  expectedSha256: string,
  plan: PreparationPlan,
  control: PrepareControl,
): Promise<PrepareOutcome> {
  control.progress("analysis", 0);
  if ((await sha256(bytes)) !== expectedSha256)
    throw new Error("The source changed after the job was saved.");
  const decoded = await decodeWav(new Blob([bytes]));
  await control.checkpoint();
  const current = planPreparation(analyzeAudio(decoded), wavInfo(decoded));
  if (!current.valid || JSON.stringify(current.plan) !== JSON.stringify(plan))
    return {
      status: "review",
      reasons: ["The current source analysis does not support this job."],
    };
  control.progress("conversion", 0);
  const converted = await stretchAudio(
    {
      channels: decoded.channels,
      sampleRate: decoded.sampleRate,
      outputFrames: plan.outputFrames,
      semitones: plan.semitones,
      circular: true,
    },
    {
      checkpoint: async (fraction) => {
        control.progress("conversion", fraction);
        await control.checkpoint();
      },
    },
  );
  control.progress("validation", 0);
  let peak = 0;
  for (const channel of converted.channels)
    for (const value of channel) {
      if (!Number.isFinite(value))
        throw new Error("The conversion produced invalid audio values.");
      peak = Math.max(peak, Math.abs(value));
    }
  // Float output stores peaks above full scale without clipping.
  if (peak > MAX_OUTPUT_PEAK)
    return {
      status: "review",
      reasons: ["The prepared audio level is not plausible. It needs review."],
    };
  const encoded = encodeFloatWav(
    converted.channels,
    decoded.sampleRate,
    plan.loop,
  );
  await control.checkpoint();
  const output = await decodeWav(new Blob([encoded]));
  const analysis = analyzeAudio(output, { expectedBpm: plan.targetBpm });
  const reasons = outputReasons(plan, output, analysis);
  control.progress("validation", 1);
  if (reasons.length) return { status: "review", reasons };
  return {
    status: "validated",
    bytes: encoded,
    sha256: await sha256(encoded),
    info: wavInfo(output),
    analysis,
    measurements: {
      stretchRatio: converted.stretchedFrames / plan.inputFrames,
      pitchRatio: converted.stretchedFrames / plan.outputFrames,
      latencyFrames: converted.latencyFrames,
      peak,
    },
  };
}
