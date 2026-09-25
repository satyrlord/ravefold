import type { DecodedWav } from "../audio/pcm.ts";

/** The user's statement about the musical class of a source. */
export type TonalClass = "tonal" | "key-neutral";

export interface KeyChoice {
  /** Pitch class of the key root. C is 0. */
  root: number;
  mode: "major" | "minor";
}

/** Frame coordinates in the unchanged source. The end frame is exclusive. */
export interface SourceRegion {
  startFrame: number;
  endFrameExclusive: number;
}

/**
 * User corrections are hypotheses for analysis. They can select one reading
 * that the measurements support. They cannot replace a measurement.
 */
export interface AnalysisCorrection {
  bpm?: number;
  tonalClass?: TonalClass;
  key?: KeyChoice;
}

export const MIN_CORRECTED_BPM = 20;
export const MAX_CORRECTED_BPM = 400;
/** The shortest region that analysis can measure as a one-shot. */
export const MIN_REGION_SECONDS = 0.1;
/** Measured and corrected tempos agree within this difference. */
export const TEMPO_TOLERANCE_BPM = 1.5;

export const KEY_NAMES = [
  "C",
  "C#",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
] as const;

const LETTERS: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** Read a stored key name, for example "F# minor". */
export function parseKeyName(value: string): KeyChoice | null {
  const match = /^([A-G])(#|b)? (major|minor)$/u.exec(value);
  if (!match) return null;
  const offset = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
  return {
    root: (LETTERS[match[1]!]! + offset + 12) % 12,
    mode: match[3] as KeyChoice["mode"],
  };
}

export function keyName(choice: KeyChoice): string {
  return `${KEY_NAMES[choice.root]} ${choice.mode}`;
}

export function validCorrectedBpm(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= MIN_CORRECTED_BPM &&
    value <= MAX_CORRECTED_BPM
  );
}

export function minimumRegionFrames(sampleRate: number): number {
  return Math.ceil(sampleRate * MIN_REGION_SECONDS);
}

/** Give the reason that a region is not usable, or null for a valid region. */
export function regionProblem(
  region: SourceRegion,
  source: { frames: number; sampleRate: number },
): string | null {
  const { startFrame, endFrameExclusive } = region;
  if (
    !Number.isSafeInteger(startFrame) ||
    !Number.isSafeInteger(endFrameExclusive) ||
    startFrame < 0 ||
    endFrameExclusive > source.frames
  )
    return "The region must be inside the source audio.";
  if (endFrameExclusive <= startFrame) return "The region is empty.";
  if (endFrameExclusive - startFrame < minimumRegionFrames(source.sampleRate))
    return `The region must be at least ${MIN_REGION_SECONDS} seconds long.`;
  return null;
}

/** True when the region is the complete source. */
export function coversSource(region: SourceRegion, frames: number): boolean {
  return region.startFrame === 0 && region.endFrameExclusive === frames;
}

/** Give the region audio as a new source view. Loop markers do not apply. */
export function sliceRegion(
  decoded: DecodedWav,
  region: SourceRegion,
): DecodedWav {
  return {
    sampleRate: decoded.sampleRate,
    frames: region.endFrameExclusive - region.startFrame,
    channels: decoded.channels.map((channel) =>
      channel.slice(region.startFrame, region.endFrameExclusive),
    ),
    encoding: decoded.encoding,
  };
}

/** A short label for a region, in seconds with millisecond precision. */
export function regionLabel(region: SourceRegion, sampleRate: number): string {
  const seconds = (frame: number) => (frame / sampleRate).toFixed(3);
  return `${seconds(region.startFrame)}–${seconds(region.endFrameExclusive)} s`;
}
