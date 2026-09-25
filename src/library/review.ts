import type { ReviewRequest } from "../audio/analyze-request.ts";
import type { CorrectedAudio } from "../domain/audio-manifest.ts";
import {
  analysisCorrection,
  type PlanCorrection,
} from "../domain/preparation.ts";
import {
  MAX_CORRECTED_BPM,
  MIN_CORRECTED_BPM,
  parseKeyName,
  regionProblem,
  validCorrectedBpm,
  type SourceRegion,
  type TonalClass,
} from "../domain/review.ts";
import type { WavInfo } from "../domain/wav.ts";

/** The values that a user sends for validation again. */
export interface ReviewInput {
  bpm: number | null;
  key: string | null;
  tonalClass: TonalClass | null;
  region: SourceRegion | null;
}

export const EMPTY_REVIEW: ReviewInput = {
  bpm: null,
  key: null,
  tonalClass: null,
  region: null,
};

export function isEmptyReview(input: ReviewInput): boolean {
  return (
    input.bpm === null &&
    input.key === null &&
    input.tonalClass === null &&
    input.region === null
  );
}

/** Give the reason that the input cannot go to validation, or null. */
export function reviewInputProblem(
  input: ReviewInput,
  wav: Pick<WavInfo, "frames" | "sampleRate">,
): string | null {
  if (input.bpm !== null && !validCorrectedBpm(input.bpm))
    return `Enter a source tempo from ${MIN_CORRECTED_BPM} to ${MAX_CORRECTED_BPM} BPM.`;
  if (input.key !== null && !parseKeyName(input.key))
    return "Select a valid source key.";
  if (input.tonalClass === "key-neutral" && input.key !== null)
    return "Key-neutral audio has no musical key. Clear the key.";
  return input.region ? regionProblem(input.region, wav) : null;
}

export function planCorrection(input: ReviewInput): PlanCorrection | null {
  const correction = {
    bpm: input.bpm,
    key: input.key,
    tonalClass: input.tonalClass,
  };
  return analysisCorrection(correction) ? correction : null;
}

export function reviewRequest(input: ReviewInput): ReviewRequest {
  const correction = analysisCorrection(planCorrection(input));
  return { region: input.region, ...(correction ? { correction } : {}) };
}

export function correctedAudio(input: ReviewInput): CorrectedAudio {
  return {
    bpm: input.bpm,
    key: input.key,
    tonalClass: input.tonalClass,
    region: input.region ? { ...input.region } : null,
  };
}

export function reviewInput(corrected: CorrectedAudio): ReviewInput {
  return {
    bpm: corrected.bpm,
    key: corrected.key,
    tonalClass: corrected.tonalClass ?? null,
    region: corrected.region ? { ...corrected.region } : null,
  };
}
