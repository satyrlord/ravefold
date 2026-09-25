import { nearestShiftToC } from "../domain/music.ts";
import {
  TEMPO_TOLERANCE_BPM,
  type AnalysisCorrection,
} from "../domain/review.ts";
import type { DecodedWav } from "./pcm.ts";

export const AUDIO_ANALYSIS_VERSION = "audio-analysis-v3" as const;
export const AUDIO_ANALYSIS_VERSIONS = [
  "audio-analysis-v2",
  AUDIO_ANALYSIS_VERSION,
] as const;

export type AnalyzedSampleKind =
  | "unpitched-one-shot"
  | "key-neutral-loop"
  | "tonal-loop"
  | "tuned-percussion"
  | "source-backed-compatible-loop"
  | "source-backed-one-shot"
  | "uncertain";

export interface SourceBackedEvidence {
  gridErrorBeats: number;
  gridBeatsAt180: number;
  attackCount: number;
  peakRms: number;
  activeSpectralWindows: number;
  hardConflict: false;
  detuned: false;
  incompatibleClasses: false;
  incompatibleLines: false;
  envelopeCorrelation180?: number;
  earlyPeakFraction?: number;
  decayRatio?: number;
}

export interface AudioMeasurements {
  sampleKind: AnalyzedSampleKind;
  bpm?: number;
  estimatedBpm?: number;
  beatCount?: number;
  key?: "C";
  minorForm?: "natural" | "harmonic" | "melodic";
  compatiblePitchClasses?: number[];
  compatibleMinorForms?: Array<"natural" | "harmonic" | "melodic">;
  sourceBackedEvidence?: SourceBackedEvidence;
  /** A minor phrase in another key. Only a conversion result has it. */
  sourceKey?: {
    root: number;
    minorForm: "natural" | "harmonic" | "melodic";
    pitchClasses: number[];
  };
  /** The nearest semitone shift from the source root to C. */
  transposeSemitones?: number;
  /** Detector scores in [0, 1]. They are not calibrated probabilities. */
  detectorScores: { rhythm: number; pitch: number };
}

export interface AudioAnalysis {
  algorithmVersion: (typeof AUDIO_ANALYSIS_VERSIONS)[number];
  status: "ready" | "needs-conversion" | "needs-review";
  measured: AudioMeasurements;
  reasons: string[];
}

export interface AudioAnalysisContext {
  /** The caller verifies this record against the exact source-file hash. */
  verifiedOfficialSource?: true;
  /** The target of a validated preparation job for this exact output file. */
  expectedBpm?: 90 | 180;
  /** User hypotheses. They select only among measured readings. */
  correction?: AnalysisCorrection;
}

interface PitchEstimate {
  pitchClass: number | null;
  score: number;
  frequency?: number;
}

const MAX_ANALYSIS_SECONDS = 30;
const MAX_ONSETS = 64;
const MIN_SIGNAL_RMS = 0.008;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function result(
  status: AudioAnalysis["status"],
  sampleKind: AnalyzedSampleKind,
  reason: string,
  scores: AudioMeasurements["detectorScores"],
  facts: Partial<Omit<AudioMeasurements, "sampleKind" | "detectorScores">> = {},
): AudioAnalysis {
  return {
    algorithmVersion: AUDIO_ANALYSIS_VERSION,
    status,
    measured: { sampleKind, ...facts, detectorScores: scores },
    reasons: [reason],
  };
}

/** Find a stable monophonic fundamental. Noise and complex chords abstain. */
function pitchAt(
  audio: Float32Array,
  sampleRate: number,
  start: number,
  end: number,
): PitchEstimate | null {
  const length = Math.min(3072, end - start);
  if (length < 1024) return null;
  let power = 0;
  for (let index = 0; index < length; index++)
    power += audio[start + index]! ** 2;
  if (power / length < 0.00001) return null;

  const firstLag = 2;
  const lastLag = Math.min(Math.ceil(sampleRate / 40), length - 512);
  const correlations = new Float32Array(lastLag + 2);
  let best = 0;
  for (let lag = firstLag; lag <= lastLag; lag++) {
    let product = 0;
    let leftPower = 0;
    let rightPower = 0;
    for (let index = 0; index < length - lag; index++) {
      const left = audio[start + index]!;
      const right = audio[start + index + lag]!;
      product += left * right;
      leftPower += left * left;
      rightPower += right * right;
    }
    const score = product / Math.sqrt(leftPower * rightPower || 1);
    correlations[lag] = score;
    best = Math.max(best, score);
  }
  const slowPeriodic = (): PitchEstimate | null => {
    let product = 0;
    let leftPower = 0;
    let rightPower = 0;
    for (let index = 0; index < length - 1; index++) {
      const left = audio[start + index]!;
      const right = audio[start + index + 1]!;
      product += left * right;
      leftPower += left * left;
      rightPower += right * right;
    }
    const score = product / Math.sqrt(leftPower * rightPower || 1);
    return score > 0.995 ? { pitchClass: null, score: clamp(score) } : null;
  };
  if (best < 0.88) return slowPeriodic();
  let chosenLag = 0;
  for (let lag = firstLag + 1; lag < lastLag; lag++) {
    const score = correlations[lag]!;
    if (
      score >= 0.88 &&
      score >= best - 0.07 &&
      score >= correlations[lag - 1]! &&
      score >= correlations[lag + 1]!
    ) {
      chosenLag = lag;
      break;
    }
  }
  if (!chosenLag) return slowPeriodic();
  const before = correlations[chosenLag - 1]!;
  const at = correlations[chosenLag]!;
  const after = correlations[chosenLag + 1]!;
  const denominator = before - 2 * at + after;
  const adjustment = denominator ? (before - after) / (2 * denominator) : 0;
  const frequency = sampleRate / (chosenLag + clamp(adjustment + 0.5) - 0.5);
  const midi = 69 + 12 * Math.log2(frequency / 440);
  const note = Math.round(midi);
  return {
    pitchClass: Math.abs(midi - note) <= 0.35 ? ((note % 12) + 12) % 12 : null,
    score: clamp(at),
    frequency,
  };
}

/** Reject a chord that repeats at the period of a missing low fundamental. */
function harmonicEvidence(
  audio: Float32Array,
  sampleRate: number,
  start: number,
  frequency: number | undefined,
): boolean {
  if (!frequency) return false;
  const length = Math.min(3072, audio.length - start);
  if (length < 1024) return false;
  let totalPower = 0;
  const windowed = new Float64Array(length);
  for (let index = 0; index < length; index++) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (length - 1));
    const value = audio[start + index]! * window;
    windowed[index] = value;
    totalPower += value * value;
  }
  if (totalPower < 1e-5) return false;
  let lowEnergy = 0;
  let harmonicEnergy = 0;
  const count = Math.min(12, Math.floor((sampleRate * 0.48) / frequency));
  for (let harmonic = 1; harmonic <= count; harmonic++) {
    const angle = (2 * Math.PI * harmonic * frequency) / sampleRate;
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < length; index++) {
      const phase = index * angle;
      real += windowed[index]! * Math.cos(phase);
      imaginary += windowed[index]! * Math.sin(phase);
    }
    const energy =
      (real * real + imaginary * imaginary) / (length * totalPower);
    harmonicEnergy += energy;
    if (harmonic <= 3) lowEnergy += energy;
  }
  return harmonicEnergy * 3 >= 0.6 && lowEnergy >= harmonicEnergy * 0.38;
}

function minorForm(
  classes: ReadonlySet<number>,
): AudioMeasurements["minorForm"] {
  if (classes.size < 5 || ![0, 3, 7].every((note) => classes.has(note)))
    return undefined;
  if ([1, 4, 6].some((note) => classes.has(note))) return undefined;
  const aFlat = classes.has(8);
  const a = classes.has(9);
  const bFlat = classes.has(10);
  const b = classes.has(11);
  if (aFlat && bFlat && !a && !b) return "natural";
  if (aFlat && b && !a && !bFlat) return "harmonic";
  if (a && b && !aFlat && !bFlat) return "melodic";
  return undefined;
}

const MINOR_FORMS = [
  { name: "natural", notes: [0, 2, 3, 5, 7, 8, 10] },
  { name: "harmonic", notes: [0, 2, 3, 5, 7, 8, 11] },
  { name: "melodic", notes: [0, 2, 3, 5, 7, 9, 11] },
] as const;

/** A short phrase can fit a form without establishing its source key. */
function compatibleForms(
  classes: ReadonlySet<number>,
): NonNullable<AudioMeasurements["compatibleMinorForms"]> {
  if (!classes.size) return [];
  return MINOR_FORMS.filter((form) =>
    [...classes].every((pitchClass) =>
      form.notes.some((note) => note === pitchClass),
    ),
  ).map((form) => form.name);
}

function compatibleFacts(
  classes: ReadonlySet<number>,
): Partial<AudioMeasurements> | null {
  const forms = compatibleForms(classes);
  if (!forms.length) return null;
  const establishedForm = minorForm(classes);
  return {
    compatiblePitchClasses: [...classes].sort((a, b) => a - b),
    compatibleMinorForms: forms,
    ...(establishedForm
      ? { key: "C" as const, minorForm: establishedForm }
      : {}),
  };
}

/**
 * Find one established minor form in another key. A pitch-class set cannot
 * separate a minor key from its relative major, so the first and last
 * measured notes must also be the root.
 */
function otherMinorKey(
  classes: ReadonlySet<number>,
  first: number,
  last: number,
): Pick<AudioMeasurements, "sourceKey" | "transposeSemitones"> | null {
  const matches: Array<{
    root: number;
    minorForm: NonNullable<AudioMeasurements["minorForm"]>;
  }> = [];
  for (let root = 1; root < 12; root++) {
    const form = minorForm(
      new Set([...classes].map((pitchClass) => (pitchClass - root + 12) % 12)),
    );
    if (form) matches.push({ root, minorForm: form });
  }
  if (matches.length !== 1) return null;
  const { root, minorForm: form } = matches[0]!;
  if (first !== root || last !== root) return null;
  return {
    sourceKey: {
      root,
      minorForm: form,
      pitchClasses: [...classes].sort((a, b) => a - b),
    },
    transposeSemitones: nearestShiftToC(root),
  };
}

/** Use a corrected root only when the notes establish a minor form on it. */
function minorKeyAt(
  classes: ReadonlySet<number>,
  root: number,
): Pick<AudioMeasurements, "sourceKey" | "transposeSemitones"> | null {
  const form = minorForm(
    new Set([...classes].map((pitchClass) => (pitchClass - root + 12) % 12)),
  );
  if (!form) return null;
  return {
    sourceKey: {
      root,
      minorForm: form,
      pitchClasses: [...classes].sort((a, b) => a - b),
    },
    transposeSemitones: nearestShiftToC(root),
  };
}

/** A supported tempo that a correction names, within the tempo tolerance. */
function correctedSupportedBpm(
  context: AudioAnalysisContext | undefined,
): 90 | 180 | undefined {
  const bpm = context?.correction?.bpm;
  if (bpm === undefined) return undefined;
  return ([90, 180] as const).find(
    (supported) => Math.abs(bpm - supported) <= TEMPO_TOLERANCE_BPM,
  );
}

function bestCompatibleSubset(classes: ReadonlySet<number>): Set<number> {
  let best = new Set<number>();
  for (const form of MINOR_FORMS) {
    const subset = new Set(
      [...classes].filter((pitchClass) =>
        form.notes.some((note) => note === pitchClass),
      ),
    );
    if (subset.size > best.size) best = subset;
  }
  return best;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sameValues<T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
) {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((value, index) => value === right[index]))
  );
}

function envelopeCorrelation(
  rms: Float32Array,
  sampleRate: number,
  blockFrames: number,
  bpm: 90 | 180,
): number {
  const lag = Math.round((60 / bpm / blockFrames) * sampleRate);
  if (lag < 1 || lag >= rms.length) return 0;
  let mean = 0;
  for (const value of rms) mean += value;
  mean /= rms.length;
  let product = 0;
  let leftPower = 0;
  let rightPower = 0;
  for (let index = 0; index + lag < rms.length; index++) {
    const left = Math.max(0, rms[index]! - mean);
    const right = Math.max(0, rms[index + lag]! - mean);
    product += left * right;
    leftPower += left * left;
    rightPower += right * right;
  }
  return clamp(product / Math.sqrt(leftPower * rightPower || 1));
}

function spectralPower(
  audio: Float32Array,
  start: number,
  size: number,
): Float64Array | null {
  if (audio.length < size) return null;
  const first = Math.min(start, audio.length - size);
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let index = 0; index < size; index++) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (size - 1));
    real[index] = audio[first + index]! * window;
  }
  for (let index = 1, reversed = 0; index < size; index++) {
    let bit = size >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      const value = real[index]!;
      real[index] = real[reversed]!;
      real[reversed] = value;
    }
  }
  for (let span = 2; span <= size; span *= 2) {
    const angle = (-2 * Math.PI) / span;
    for (let startBin = 0; startBin < size; startBin += span) {
      for (let bin = 0; bin < span / 2; bin++) {
        const cosine = Math.cos(angle * bin);
        const sine = Math.sin(angle * bin);
        const right = startBin + bin + span / 2;
        const left = startBin + bin;
        const rotatedReal = real[right]! * cosine - imaginary[right]! * sine;
        const rotatedImaginary =
          real[right]! * sine + imaginary[right]! * cosine;
        real[right] = real[left]! - rotatedReal;
        imaginary[right] = imaginary[left]! - rotatedImaginary;
        real[left] += rotatedReal;
        imaginary[left] += rotatedImaginary;
      }
    }
  }
  const power = new Float64Array(size / 2 + 1);
  for (let bin = 0; bin <= size / 2; bin++)
    power[bin] = real[bin]! ** 2 + imaginary[bin]! ** 2;
  return power;
}

function spectralFlatness(audio: Float32Array, start: number): number {
  const size = 2048;
  const power = spectralPower(audio, start, size);
  if (!power) return 0;
  let sum = 0;
  const count = size / 2 - 1;
  for (let bin = 2; bin <= size / 2; bin++) sum += power[bin]!;
  const mean = sum / count;
  if (mean < 1e-10) return 0;
  let logarithms = 0;
  for (let bin = 2; bin <= size / 2; bin++) {
    logarithms += Math.log(Math.max(power[bin]!, mean * 1e-9));
  }
  return clamp(Math.exp(logarithms / count) / mean);
}

interface SpectralEvidence {
  classes: Set<number>;
  lineClasses: Set<number>;
  tonalWindows: number;
  broadWindows: number;
  activeWindows: number;
  incompatible: boolean;
  hardConflict: boolean;
  detuned: boolean;
  tonalExclusion: boolean;
}

/** Read stable spectral fundamentals, including notes inside a chord. */
function spectralEvidence(
  audio: Float32Array,
  sampleRate: number,
): SpectralEvidence {
  const classes = new Set<number>();
  const empty = {
    classes,
    lineClasses: new Set<number>(),
    tonalWindows: 0,
    broadWindows: 0,
    activeWindows: 0,
    incompatible: false,
    hardConflict: false,
    detuned: false,
    tonalExclusion: false,
  };
  const size = audio.length >= 8192 ? 8192 : audio.length >= 4096 ? 4096 : 0;
  if (!size) return empty;
  const windows = Math.min(
    16,
    Math.max(3, Math.floor(audio.length / size) * 2),
  );
  const support = new Float64Array(12);
  const seen = new Uint8Array(12);
  const clearSeen = new Uint8Array(12);
  const lineSeen = new Map<number, number>();
  let tonalWindows = 0;
  let broadWindows = 0;
  let activeWindows = 0;
  let detunedWindows = 0;
  for (let window = 0; window < windows; window++) {
    const start = Math.round(((audio.length - size) * window) / (windows - 1));
    const power = spectralPower(audio, start, size)!;
    const firstBin = Math.max(2, Math.ceil((80 * size) / sampleRate));
    const lastBin = Math.min(
      power.length - 2,
      Math.floor((4000 * size) / sampleRate),
    );
    let total = 0;
    let strongest = 0;
    for (let bin = firstBin; bin <= lastBin; bin++) {
      total += power[bin]!;
      strongest = Math.max(strongest, power[bin]!);
    }
    if (total < 0.0001) continue;
    activeWindows++;
    const mean = total / (lastBin - firstBin + 1);
    const windowLines = new Set<number>();
    for (let bin = firstBin + 1; bin < lastBin; bin++) {
      const value = power[bin]!;
      if (
        value < mean * 12 ||
        value < power[bin - 1]! * 1.8 ||
        value < power[bin + 1]! * 1.8
      )
        continue;
      const frequency = (bin * sampleRate) / size;
      const midi = 69 + 12 * Math.log2(frequency / 440);
      if (Math.abs(midi - Math.round(midi)) <= 0.4)
        windowLines.add(Math.round(midi));
    }
    for (const note of windowLines)
      lineSeen.set(note, (lineSeen.get(note) ?? 0) + 1);
    if (strongest / total < 0.12) {
      let logarithms = 0;
      for (let bin = firstBin; bin <= lastBin; bin++)
        logarithms += Math.log(Math.max(power[bin]!, mean * 1e-9));
      const flatness = Math.exp(logarithms / (lastBin - firstBin + 1)) / mean;
      if (flatness >= 0.18) broadWindows++;
      continue;
    }
    const peaks: Array<{ frequency: number; strength: number }> = [];
    for (let bin = firstBin + 1; bin < lastBin; bin++) {
      const value = power[bin]!;
      if (
        value < strongest * 0.2 ||
        value < power[bin - 1]! ||
        value < power[bin + 1]!
      )
        continue;
      const before = power[bin - 1]!;
      const after = power[bin + 1]!;
      const denominator = before - 2 * value + after;
      const offset = denominator
        ? Math.max(-0.5, Math.min(0.5, (before - after) / (2 * denominator)))
        : 0;
      peaks.push({
        frequency: ((bin + offset) * sampleRate) / size,
        strength: value / strongest,
      });
    }
    peaks.sort((a, b) => a.frequency - b.frequency);
    const loudestPeak = peaks.reduce(
      (best, peak) => (peak.strength > best.strength ? peak : best),
      { frequency: 0, strength: 0 },
    );
    if (loudestPeak.strength && strongest / total >= 0.2) {
      const loudestMidi = 69 + 12 * Math.log2(loudestPeak.frequency / 440);
      if (Math.abs(loudestMidi - Math.round(loudestMidi)) > 0.35)
        detunedWindows++;
    }
    const fundamentals = peaks.filter(
      (peak) =>
        !peaks.some((lower) => {
          if (lower.frequency >= peak.frequency) return false;
          const multiple = Math.round(peak.frequency / lower.frequency);
          return (
            multiple >= 2 &&
            multiple <= 12 &&
            Math.abs(peak.frequency / lower.frequency - multiple) < 0.035 &&
            lower.strength >= peak.strength * 0.8
          );
        }),
    );
    const windowClasses = new Set<number>();
    const clearNotes = new Set<number>();
    for (const peak of fundamentals) {
      const midi = 69 + 12 * Math.log2(peak.frequency / 440);
      const rounded = Math.round(midi);
      if (Math.abs(midi - rounded) > 0.35) continue;
      const pitchClass = ((rounded % 12) + 12) % 12;
      support[pitchClass] += peak.strength;
      windowClasses.add(pitchClass);
      if (peak.strength >= 0.5) clearNotes.add(pitchClass);
    }
    if (windowClasses.size) tonalWindows++;
    for (const pitchClass of windowClasses) {
      seen[pitchClass]!++;
    }
    if (strongest / total >= 0.28)
      for (const pitchClass of clearNotes) clearSeen[pitchClass]!++;
  }
  const strongestClass = Math.max(...support);
  for (let pitchClass = 0; pitchClass < 12; pitchClass++)
    if (seen[pitchClass]! >= 3 && support[pitchClass]! >= strongestClass * 0.55)
      classes.add(pitchClass);
  const foreignNote = [1, 4, 6].some((note) => clearSeen[note]! >= 2);
  const mixedForms = [
    [8, 9],
    [9, 10],
    [10, 11],
  ].some(([a, b]) => clearSeen[a]! >= 2 && clearSeen[b]! >= 2);
  const persistentForeign = [1, 4, 6].some(
    (note) =>
      seen[note]! >= Math.max(4, activeWindows * 0.5) &&
      support[note]! >= strongestClass * 0.55,
  );
  const hardConflict = foreignNote || mixedForms || persistentForeign;
  const persistentNotes = [...lineSeen].filter(
    ([, count]) => count >= Math.max(3, activeWindows * 0.5),
  );
  const lineClasses = new Set(
    persistentNotes.map(([note]) => ((note % 12) + 12) % 12),
  );
  return {
    classes,
    lineClasses,
    tonalWindows,
    broadWindows,
    activeWindows,
    incompatible:
      hardConflict ||
      (classes.size > 0 && compatibleForms(classes).length === 0),
    hardConflict,
    detuned: detunedWindows >= 2 && detunedWindows >= activeWindows * 0.6,
    tonalExclusion: persistentNotes.length >= 2,
  };
}

function compatibleLineFacts(
  spectrum: SpectralEvidence,
): Partial<AudioMeasurements> | null {
  if (!spectrum.tonalExclusion || spectrum.detuned || spectrum.hardConflict)
    return null;
  return compatibleFacts(spectrum.lineClasses);
}

/** Require broad spectral energy before key-neutral acceptance. */
function aperiodicityEvidence(
  rms: Float32Array,
  audio: Float32Array,
  blockFrames: number,
  peak: number,
  minimumChecks: number,
): { supported: boolean; periodicityScore: number } {
  const activeBlocks: number[] = [];
  for (let block = 0; block < rms.length; block += 2) {
    if (rms[block]! >= peak * 0.08) activeBlocks.push(block);
  }
  if (activeBlocks.length < minimumChecks)
    return { supported: false, periodicityScore: 0 };
  const checks = Math.min(16, activeBlocks.length);
  for (let index = 0; index < checks; index++) {
    const block =
      activeBlocks[Math.floor((index * activeBlocks.length) / checks)]!;
    const flatness = spectralFlatness(audio, block * blockFrames);
    if (flatness < 0.04)
      return { supported: false, periodicityScore: clamp(1 - flatness) };
  }
  return { supported: true, periodicityScore: 0 };
}

/** Fall back to repeated envelope evidence for syncopated loops. */
function periodicLoop(
  rms: Float32Array,
  audio: Float32Array,
  sampleRate: number,
  blockFrames: number,
  frames: number,
  peak: number,
  context?: AudioAnalysisContext,
): AudioAnalysis | null {
  const duration = frames / sampleRate;
  const candidates = ([90, 180] as const).map((bpm) => {
    const exactBeats = (duration * bpm) / 60;
    const beatCount = Math.round(exactBeats);
    return {
      bpm,
      beatCount,
      score:
        beatCount >= 4 &&
        beatCount <= 64 &&
        Math.abs(exactBeats - beatCount) <= 0.025
          ? envelopeCorrelation(rms, sampleRate, blockFrames, bpm)
          : 0,
    };
  });
  candidates.sort((a, b) => b.score - a.score);
  const first = candidates[0]!;
  const second = candidates[1]!;
  if (first.score < 0.45) return null;
  const correctedBpm = correctedSupportedBpm(context);
  const preferredBpm =
    context?.expectedBpm ??
    correctedBpm ??
    (context?.verifiedOfficialSource ? 180 : undefined);
  const preferred = candidates.find(
    (candidate) => candidate.bpm === preferredBpm,
  );
  const chosen = preferred && preferred.score >= 0.45 ? preferred : first;
  const rhythmScore = chosen.score;
  if (context?.verifiedOfficialSource && chosen.bpm !== 180)
    return result(
      "needs-review",
      "uncertain",
      "Measured rhythm does not support the verified 180 BPM source grid.",
      { rhythm: first.score, pitch: 0 },
    );
  if (context?.expectedBpm && chosen.bpm !== context.expectedBpm)
    return result(
      "needs-review",
      "uncertain",
      "Measured rhythm does not support the prepared tempo.",
      { rhythm: first.score, pitch: 0 },
    );
  if (correctedBpm && chosen.bpm !== correctedBpm)
    return result(
      "needs-review",
      "uncertain",
      "Measured rhythm does not support the corrected tempo.",
      { rhythm: first.score, pitch: 0 },
    );
  const resolved = Boolean(context?.verifiedOfficialSource || preferred);
  if (
    (!resolved &&
      chosen.bpm === 180 &&
      candidates.some(
        (candidate) => candidate.bpm === 90 && candidate.beatCount >= 4,
      )) ||
    (chosen === first && first.score - second.score < 0.12 && !resolved)
  )
    return result(
      "needs-review",
      "uncertain",
      "The loop can fit both 90 and 180 BPM.",
      { rhythm: rhythmScore, pitch: 0 },
    );
  const tempoFacts = {
    bpm: chosen.bpm,
    estimatedBpm: chosen.bpm,
    beatCount: chosen.beatCount,
  };
  const spectrum = spectralEvidence(audio, sampleRate);
  const noteClasses =
    spectrum.incompatible &&
    context?.verifiedOfficialSource &&
    !spectrum.hardConflict
      ? bestCompatibleSubset(spectrum.classes)
      : spectrum.classes;
  const lineFacts = context?.verifiedOfficialSource
    ? compatibleLineFacts(spectrum)
    : null;
  if (
    spectrum.detuned ||
    spectrum.hardConflict ||
    (spectrum.incompatible &&
      (!context?.verifiedOfficialSource || (!noteClasses.size && !lineFacts)))
  )
    return result(
      "needs-review",
      "tonal-loop",
      "Measured spectral notes are incompatible or unstable.",
      { rhythm: rhythmScore, pitch: 0 },
      tempoFacts,
    );
  if (noteClasses.size && spectrum.tonalWindows >= 2) {
    const facts = compatibleFacts(noteClasses)!;
    return result(
      "ready",
      "tonal-loop",
      "Measured spectral notes fit C minor and the loop has a supported tempo.",
      { rhythm: rhythmScore, pitch: 0.75 },
      { ...tempoFacts, ...facts },
    );
  }
  if (lineFacts)
    return result(
      "ready",
      "tonal-loop",
      "Persistent notes fit C minor and the loop has a supported tempo.",
      { rhythm: rhythmScore, pitch: 0.6 },
      { ...tempoFacts, ...lineFacts },
    );
  if (
    spectrum.activeWindows >= 3 &&
    spectrum.broadWindows >= spectrum.activeWindows * 0.7 &&
    !spectrum.tonalExclusion
  )
    return result(
      "ready",
      "key-neutral-loop",
      "Measured broad-spectrum loop has a supported tempo.",
      { rhythm: rhythmScore, pitch: 0 },
      tempoFacts,
    );
  const segments = Math.min(16, Math.max(8, chosen.beatCount));
  const pitches: PitchEstimate[] = [];
  let activeSegments = 0;
  for (let segment = 0; segment < segments; segment++) {
    const start = Math.floor((segment * rms.length) / segments);
    const end = Math.max(
      start + 1,
      Math.floor(((segment + 1) * rms.length) / segments),
    );
    let strongestBlock = start;
    for (let block = start + 1; block < end; block++)
      if (rms[block]! > rms[strongestBlock]!) strongestBlock = block;
    if (rms[strongestBlock]! < peak * 0.08) continue;
    activeSegments++;
    const frame = Math.min(
      frames,
      strongestBlock * blockFrames + Math.round(sampleRate * 0.04),
    );
    const pitch = pitchAt(
      audio,
      sampleRate,
      frame,
      Math.min(frames, frame + 3072),
    );
    if (pitch) pitches.push(pitch);
  }
  const pitchScore = pitches.length
    ? average(pitches.map((pitch) => pitch.score))
    : 0;
  if (pitches.length && pitches.length >= activeSegments * 0.75) {
    if (pitches.some((pitch) => pitch.pitchClass === null))
      return result(
        "needs-review",
        "uncertain",
        "The loop has no stable set of musical notes.",
        { rhythm: rhythmScore, pitch: pitchScore },
        tempoFacts,
      );
    const classes = new Set(pitches.map((pitch) => pitch.pitchClass!));
    const facts = compatibleFacts(classes);
    if (!facts)
      return result(
        "needs-review",
        "tonal-loop",
        "The measured notes do not fit one C-minor form.",
        { rhythm: rhythmScore, pitch: pitchScore },
        tempoFacts,
      );
    return result(
      "ready",
      "tonal-loop",
      "Measured notes fit C minor and the loop has a supported tempo.",
      { rhythm: rhythmScore, pitch: pitchScore },
      { ...tempoFacts, ...facts },
    );
  }
  const unpitched = aperiodicityEvidence(rms, audio, blockFrames, peak, 8);
  if (!unpitched.supported || pitches.length || spectrum.tonalExclusion)
    return result(
      "needs-review",
      "uncertain",
      "Periodic tempo is measurable, but tonal class is uncertain.",
      {
        rhythm: rhythmScore,
        pitch: Math.max(pitchScore, unpitched.periodicityScore),
      },
      tempoFacts,
    );
  return result(
    "ready",
    "key-neutral-loop",
    "Measured periodic key-neutral loop has a supported tempo.",
    { rhythm: rhythmScore, pitch: 0 },
    tempoFacts,
  );
}

/** Use a verified source record only after PCM timing and notes are measured. */
function verifiedGridLoop(
  rms: Float32Array,
  audio: Float32Array,
  sampleRate: number,
  blockFrames: number,
  frames: number,
  onsets: readonly number[],
): AudioAnalysis | null {
  const duration = frames / sampleRate;
  const exactBeats = duration * 3;
  const beatCount = Math.round(exactBeats);
  if (
    beatCount < 4 ||
    beatCount > 84 ||
    Math.abs(exactBeats - beatCount) > 0.015 ||
    onsets.length < 2
  )
    return null;
  const at180 = envelopeCorrelation(rms, sampleRate, blockFrames, 180);
  if (at180 < 0.15) return null;
  if (onsets.length >= 4 && onsets.length <= MAX_ONSETS) {
    const intervals = onsets
      .slice(1)
      .map(
        (block, index) => ((block - onsets[index]!) * blockFrames) / sampleRate,
      );
    const mean = average(intervals);
    const jitter = Math.max(
      ...intervals.map((interval) => Math.abs(interval - mean) / mean),
    );
    const apparentBpm = 60 / mean;
    if (
      jitter < 0.06 &&
      Math.abs(apparentBpm - 90) > 2 &&
      Math.abs(apparentBpm - 180) > 2 &&
      Math.abs(apparentBpm - 360) > 4
    )
      return result(
        "needs-review",
        "uncertain",
        "Measured attacks contradict the 180 BPM source grid.",
        { rhythm: 0, pitch: 0 },
      );
  }
  const spectrum = spectralEvidence(audio, sampleRate);
  const tempoFacts = { bpm: 180, estimatedBpm: 180, beatCount };
  const rhythmScore = clamp(0.5 + at180 * 0.5);
  const noteClasses =
    spectrum.incompatible && !spectrum.hardConflict
      ? bestCompatibleSubset(spectrum.classes)
      : spectrum.classes;
  const lineFacts = compatibleLineFacts(spectrum);
  if (
    spectrum.detuned ||
    spectrum.hardConflict ||
    (spectrum.incompatible && !noteClasses.size && !lineFacts)
  )
    return result(
      "needs-review",
      "tonal-loop",
      "Measured spectral notes are incompatible or unstable.",
      { rhythm: rhythmScore, pitch: 0 },
      tempoFacts,
    );
  if (noteClasses.size && spectrum.tonalWindows >= 2) {
    const facts = compatibleFacts(noteClasses)!;
    return result(
      "ready",
      "tonal-loop",
      "Measured notes and the verified source grid support use at 180 BPM.",
      { rhythm: rhythmScore, pitch: 0.75 },
      { ...tempoFacts, ...facts },
    );
  }
  if (lineFacts)
    return result(
      "ready",
      "tonal-loop",
      "Persistent notes and the verified source grid support 180 BPM.",
      { rhythm: rhythmScore, pitch: 0.6 },
      { ...tempoFacts, ...lineFacts },
    );
  if (
    spectrum.activeWindows >= 3 &&
    spectrum.broadWindows >= spectrum.activeWindows * 0.7 &&
    !spectrum.tonalExclusion
  )
    return result(
      "ready",
      "key-neutral-loop",
      "Measured broad-spectrum audio and source grid support 180 BPM.",
      { rhythm: rhythmScore, pitch: 0 },
      tempoFacts,
    );
  return null;
}

/** Analyze PCM before any verified-source compatibility decision. */
function analyzeMeasuredAudio(
  decoded: DecodedWav,
  context?: AudioAnalysisContext,
): AudioAnalysis {
  const empty = { rhythm: 0, pitch: 0 };
  const { sampleRate, frames, channels, loop } = decoded;
  if (
    !Number.isSafeInteger(frames) ||
    frames <= 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    (channels.length !== 1 && channels.length !== 2) ||
    channels.some((channel) => channel.length !== frames)
  )
    return result(
      "needs-review",
      "uncertain",
      "The decoded audio structure needs review.",
      empty,
    );
  if (channels.length === 2) {
    const left = analyzeMeasuredAudio(
      { ...decoded, channels: [channels[0]!] },
      context,
    );
    const right = analyzeMeasuredAudio(
      { ...decoded, channels: [channels[1]!] },
      context,
    );
    const a = left.measured;
    const b = right.measured;
    const sameClass =
      left.status === right.status &&
      a.sampleKind === b.sampleKind &&
      a.bpm === b.bpm &&
      a.key === b.key &&
      a.minorForm === b.minorForm &&
      a.sourceKey?.root === b.sourceKey?.root &&
      a.sourceKey?.minorForm === b.sourceKey?.minorForm &&
      sameValues(a.sourceKey?.pitchClasses, b.sourceKey?.pitchClasses) &&
      a.transposeSemitones === b.transposeSemitones &&
      sameValues(a.compatiblePitchClasses, b.compatiblePitchClasses) &&
      sameValues(a.compatibleMinorForms, b.compatibleMinorForms) &&
      (a.estimatedBpm === undefined ||
        b.estimatedBpm === undefined ||
        Math.abs(a.estimatedBpm - b.estimatedBpm) <= 1.5);
    if (sameClass && left.status !== "needs-review") {
      return {
        algorithmVersion: AUDIO_ANALYSIS_VERSION,
        status: left.status,
        measured: {
          ...a,
          ...(a.estimatedBpm !== undefined && b.estimatedBpm !== undefined
            ? {
                estimatedBpm:
                  Math.round(((a.estimatedBpm + b.estimatedBpm) / 2) * 10) / 10,
              }
            : {}),
          detectorScores: {
            rhythm: Math.min(a.detectorScores.rhythm, b.detectorScores.rhythm),
            pitch: Math.min(a.detectorScores.pitch, b.detectorScores.pitch),
          },
        },
        reasons: ["Both stereo channels support the same measured result."],
      };
    }
    return result(
      "needs-review",
      "uncertain",
      "The stereo channels do not support the same musical result.",
      {
        rhythm: Math.min(a.detectorScores.rhythm, b.detectorScores.rhythm),
        pitch: Math.min(a.detectorScores.pitch, b.detectorScores.pitch),
      },
    );
  }
  const duration = frames / sampleRate;
  if (duration > MAX_ANALYSIS_SECONDS)
    return result(
      "needs-review",
      "uncertain",
      "This source exceeds the current analysis limit.",
      empty,
    );
  if (
    loop &&
    (!Number.isSafeInteger(loop.startFrame) ||
      !Number.isSafeInteger(loop.endFrameExclusive) ||
      loop.startFrame !== 0 ||
      loop.endFrameExclusive !== frames)
  )
    return result(
      "needs-review",
      "uncertain",
      "The loop markers do not cover the complete source.",
      empty,
    );

  const blockFrames = Math.max(128, Math.round(sampleRate / 100));
  const blockCount = Math.ceil(frames / blockFrames);
  const rms = new Float32Array(blockCount);
  for (let block = 0; block < blockCount; block++) {
    const start = block * blockFrames;
    const end = Math.min(frames, start + blockFrames);
    let power = 0;
    for (let frame = start; frame < end; frame++) {
      for (let channel = 0; channel < channels.length; channel++) {
        const value = channels[channel]![frame]!;
        if (!Number.isFinite(value))
          return result(
            "needs-review",
            "uncertain",
            "The decoded audio contains invalid samples.",
            empty,
          );
        const square = value * value;
        power += square;
      }
    }
    rms[block] = Math.sqrt(power / ((end - start) * channels.length));
  }
  const strongest = Math.max(...rms);
  if (strongest < MIN_SIGNAL_RMS)
    return result(
      "needs-review",
      "uncertain",
      "The source has too little audio for a reliable result.",
      empty,
    );
  const edgeBlocks = Math.max(1, Math.floor(blockCount * 0.2));
  const oneShotDecay =
    average(Array.from(rms.slice(-edgeBlocks))) <
      average(Array.from(rms.slice(0, edgeBlocks))) * 0.3 &&
    rms.indexOf(strongest) < blockCount * 0.4;
  const dominant = channels[0]!;
  const onsetBlocks: number[] = [];
  const minimumGap = Math.ceil((0.07 * sampleRate) / blockFrames);
  for (let block = 0; block < blockCount; block++) {
    const previous = block ? rms[block - 1]! : 0;
    if (
      rms[block]! >= strongest * 0.2 &&
      rms[block]! - previous >= strongest * 0.14 &&
      (!onsetBlocks.length || block - onsetBlocks.at(-1)! >= minimumGap)
    )
      onsetBlocks.push(block);
  }
  if (context?.verifiedOfficialSource && !oneShotDecay && duration <= 1.5) {
    const exactBeats = duration * 3;
    const beatCount = Math.round(exactBeats);
    if (
      beatCount >= 1 &&
      beatCount <= 4 &&
      Math.abs(exactBeats - beatCount) <= 0.015
    ) {
      const spectrum = spectralEvidence(dominant, sampleRate);
      const tempoFacts = { bpm: 180, estimatedBpm: 180, beatCount };
      const noteClasses =
        spectrum.incompatible && !spectrum.hardConflict
          ? bestCompatibleSubset(spectrum.classes)
          : spectrum.classes;
      const lineFacts = compatibleLineFacts(spectrum);
      if (
        spectrum.detuned ||
        spectrum.hardConflict ||
        (spectrum.incompatible && !noteClasses.size && !lineFacts)
      )
        return result(
          "needs-review",
          "uncertain",
          "Measured short-source notes are incompatible or unstable.",
          { rhythm: 0.5, pitch: 0 },
        );
      if (noteClasses.size && spectrum.tonalWindows >= 2)
        return result(
          "ready",
          "tonal-loop",
          "Measured short-source notes fit the verified 180 BPM grid.",
          { rhythm: 0.5, pitch: 0.75 },
          { ...tempoFacts, ...compatibleFacts(noteClasses)! },
        );
      if (lineFacts)
        return result(
          "ready",
          "tonal-loop",
          "Persistent short-source notes fit the verified 180 BPM grid.",
          { rhythm: 0.5, pitch: 0.6 },
          { ...tempoFacts, ...lineFacts },
        );
      if (
        spectrum.activeWindows >= 2 &&
        spectrum.broadWindows >= spectrum.activeWindows * 0.7 &&
        !spectrum.tonalExclusion &&
        envelopeCorrelation(rms, sampleRate, blockFrames, 180) >= 0.15
      )
        return result(
          "ready",
          "key-neutral-loop",
          "Measured short source fits the verified 180 BPM grid.",
          { rhythm: 0.5, pitch: 0 },
          tempoFacts,
        );
    }
  }
  if (context?.verifiedOfficialSource) {
    const verified = verifiedGridLoop(
      rms,
      dominant,
      sampleRate,
      blockFrames,
      frames,
      onsetBlocks,
    );
    if (verified) return verified;
  }
  if (onsetBlocks.length > MAX_ONSETS)
    return (
      periodicLoop(
        rms,
        dominant,
        sampleRate,
        blockFrames,
        frames,
        strongest,
        context,
      ) ??
      result(
        "needs-review",
        "uncertain",
        "The source has too many detected events for this analysis.",
        empty,
      )
    );

  const pitchForEvent = (
    block: number,
    nextBlock: number,
  ): PitchEstimate | null => {
    const earlyStart = Math.min(
      frames,
      block * blockFrames + Math.round(sampleRate * 0.005),
    );
    const lateStart = Math.min(
      frames,
      block * blockFrames + Math.round(sampleRate * 0.04),
    );
    const end = Math.min(frames, nextBlock * blockFrames - blockFrames);
    const early = pitchAt(dominant, sampleRate, earlyStart, end);
    const late = pitchAt(dominant, sampleRate, lateStart, end);
    if (
      early &&
      late &&
      early.pitchClass !== null &&
      late.pitchClass !== null &&
      early.pitchClass !== late.pitchClass
    )
      return { pitchClass: null, score: Math.min(early.score, late.score) };
    return late ?? early;
  };
  if (
    onsetBlocks.length <= 3 &&
    !loop &&
    duration >= 0.1 &&
    duration <= (onsetBlocks.length <= 1 ? 2 : 1.5) &&
    oneShotDecay
  ) {
    const decays = oneShotDecay;
    const activeBlocks = Array.from(rms).filter(
      (value) => value >= strongest * 0.08,
    ).length;
    const probes: Array<PitchEstimate | null> = [];
    for (
      let seconds = 0.002;
      seconds + 1024 / sampleRate < duration;
      seconds += 0.08
    ) {
      const start = Math.round(seconds * sampleRate);
      probes.push(
        pitchAt(dominant, sampleRate, start, Math.min(frames, start + 3072)),
      );
    }
    const periodic = probes.filter(
      (pitch): pitch is PitchEstimate => pitch !== null,
    );
    const pitchScore = periodic.length
      ? Math.max(...periodic.map((pitch) => pitch.score))
      : 0;
    const unpitched = aperiodicityEvidence(
      rms,
      dominant,
      blockFrames,
      strongest,
      2,
    );
    const spectrum = decays
      ? spectralEvidence(dominant, sampleRate)
      : undefined;
    if (spectrum?.incompatible || spectrum?.detuned)
      return result(
        "needs-review",
        "tuned-percussion",
        "Measured spectral notes are incompatible or unstable.",
        { rhythm: 0, pitch: pitchScore },
      );
    if (
      decays &&
      activeBlocks >= 4 &&
      unpitched.supported &&
      !periodic.length &&
      !spectrum?.tonalExclusion
    )
      return result(
        "ready",
        "unpitched-one-shot",
        "Measured unpitched one-shot needs no tempo or key conversion.",
        { rhythm: 0, pitch: Math.max(pitchScore, unpitched.periodicityScore) },
      );
    if (
      decays &&
      spectrum &&
      spectrum.activeWindows >= 2 &&
      spectrum.broadWindows >= spectrum.activeWindows * 0.7 &&
      !spectrum.tonalExclusion &&
      !periodic.length
    )
      return result(
        "ready",
        "unpitched-one-shot",
        "Measured broad-spectrum one-shot needs no tempo or key conversion.",
        { rhythm: 0, pitch: 0 },
      );
    if (
      decays &&
      spectrum &&
      spectrum.classes.size &&
      spectrum.tonalWindows >= 2 &&
      !spectrum.incompatible &&
      (!periodic.length ||
        (context?.verifiedOfficialSource &&
          periodic.every(
            (pitch) =>
              pitch.pitchClass === null ||
              [0, 2, 3, 5, 7, 8, 9, 10, 11].includes(pitch.pitchClass) ||
              pitch.score < 0.95,
          )) ||
        (periodic.every((pitch) => pitch.pitchClass !== null) &&
          harmonicEvidence(
            dominant,
            sampleRate,
            Math.round(sampleRate * 0.04),
            periodic[0]!.frequency,
          )))
    ) {
      const facts = compatibleFacts(spectrum.classes)!;
      return result(
        "ready",
        "tuned-percussion",
        "Measured one-shot notes fit C minor.",
        { rhythm: 0, pitch: 0.75 },
        facts,
      );
    }
    if (
      decays &&
      activeBlocks >= 4 &&
      periodic.length >= 2 &&
      periodic.every(
        (pitch) =>
          pitch.pitchClass !== null &&
          pitch.pitchClass === periodic[0]!.pitchClass,
      ) &&
      average(periodic.map((pitch) => pitch.score)) >= 0.97 &&
      harmonicEvidence(
        dominant,
        sampleRate,
        Math.round(sampleRate * 0.04),
        periodic[0]!.frequency,
      )
    ) {
      const facts = compatibleFacts(new Set([periodic[0]!.pitchClass!]));
      if (facts)
        return result(
          "ready",
          "tuned-percussion",
          "Measured one-shot pitch is compatible with C minor.",
          { rhythm: 0, pitch: pitchScore },
          facts,
        );
    }
    return result(
      "needs-review",
      periodic.length ? "tuned-percussion" : "uncertain",
      "The one-shot class is uncertain or has a musical pitch.",
      { rhythm: 0, pitch: pitchScore },
    );
  }
  if (onsetBlocks.length < 4)
    return (
      periodicLoop(
        rms,
        dominant,
        sampleRate,
        blockFrames,
        frames,
        strongest,
        context,
      ) ??
      result(
        "needs-review",
        "uncertain",
        "The source has too few clear events to establish its tempo.",
        empty,
      )
    );

  const onsetTimes = onsetBlocks.map(
    (block) => (block * blockFrames) / sampleRate,
  );
  const intervals = onsetTimes
    .slice(1)
    .map((time, index) => time - onsetTimes[index]!);
  const beatSeconds =
    (onsetTimes.at(-1)! - onsetTimes[0]!) / (onsetTimes.length - 1);
  const maximumJitter = Math.max(
    ...intervals.map(
      (interval) => Math.abs(interval - beatSeconds) / beatSeconds,
    ),
  );
  const beatCount = Math.round(duration / beatSeconds);
  const durationError = Math.abs(duration / beatSeconds - beatCount);
  const firstError = onsetTimes[0]! / beatSeconds;
  const rhythmScore = clamp(
    1 - Math.max(maximumJitter / 0.08, durationError / 0.12, firstError / 0.12),
  );
  if (
    beatCount < 4 ||
    beatCount > MAX_ONSETS ||
    onsetBlocks.length !== beatCount ||
    maximumJitter > 0.06 ||
    durationError > 0.08 ||
    firstError > 0.08
  )
    return (
      periodicLoop(
        rms,
        dominant,
        sampleRate,
        blockFrames,
        frames,
        strongest,
        context,
      ) ??
      result(
        "needs-review",
        "uncertain",
        "The rhythm or whole-loop duration is uncertain.",
        { rhythm: rhythmScore, pitch: 0 },
      )
    );
  const estimatedBpm = Math.round((60 / beatSeconds) * 10) / 10;
  const scores = { rhythm: rhythmScore, pitch: 0 };
  let supportedBpm = ([90, 180] as const).find(
    (supported) => Math.abs(estimatedBpm - supported) <= TEMPO_TOLERANCE_BPM,
  );
  const tempoIsReady = supportedBpm !== undefined;
  const correctedBpm = correctedSupportedBpm(context);
  let gridBeats = beatCount;
  if (supportedBpm !== undefined) {
    const otherBpm = supportedBpm === 90 ? 180 : 90;
    const otherBeats = (duration * otherBpm) / 60;
    if (
      otherBeats >= 4 &&
      Math.abs(otherBeats - Math.round(otherBeats)) <= 0.025
    ) {
      const chosenScore = envelopeCorrelation(
        rms,
        sampleRate,
        blockFrames,
        supportedBpm,
      );
      const otherScore = envelopeCorrelation(
        rms,
        sampleRate,
        blockFrames,
        otherBpm,
      );
      const resolved =
        context?.verifiedOfficialSource ||
        context?.expectedBpm === supportedBpm ||
        correctedBpm !== undefined;
      if (
        (supportedBpm === 180 && !resolved) ||
        (otherScore >= 0.45 && chosenScore - otherScore < 0.12 && !resolved)
      ) {
        return result(
          "needs-review",
          "uncertain",
          "The loop can fit both 90 and 180 BPM.",
          { rhythm: Math.max(chosenScore, otherScore), pitch: 0 },
        );
      }
      // The duration fits both grids. A correction selects the other reading.
      if (correctedBpm === otherBpm) {
        supportedBpm = otherBpm;
        gridBeats = Math.round(otherBeats);
      }
    }
  }
  const tempoFacts = {
    bpm: supportedBpm ?? estimatedBpm,
    estimatedBpm,
    beatCount: gridBeats,
  };
  if (context?.verifiedOfficialSource && supportedBpm === 90)
    return result(
      "needs-review",
      "uncertain",
      "Measured 90 BPM attacks contradict the verified 180 BPM source grid.",
      scores,
    );
  if (context?.expectedBpm && supportedBpm !== context.expectedBpm)
    return result(
      "needs-review",
      "uncertain",
      "Measured attacks do not support the prepared tempo.",
      scores,
      tempoFacts,
    );
  const shortEvent = onsetBlocks.some((block, index) => {
    const next = onsetBlocks[index + 1] ?? blockCount;
    let active = 0;
    for (let current = block; current < next; current++)
      if (rms[current]! >= strongest * 0.08) active++;
    return active < 4;
  });
  if (shortEvent)
    return result(
      "needs-review",
      "uncertain",
      "An audio event is too short for reliable pitch analysis.",
      scores,
      tempoFacts,
    );
  const pitches = onsetBlocks.map((block, index) =>
    pitchForEvent(block, onsetBlocks[index + 1] ?? blockCount),
  );
  const pitched = pitches.filter(
    (pitch): pitch is PitchEstimate => pitch !== null,
  );
  scores.pitch = pitched.length
    ? average(pitched.map((pitch) => pitch.score))
    : 0;
  if (!pitched.length) {
    if (
      supportedBpm === 90 &&
      context?.expectedBpm !== 90 &&
      correctedBpm !== 90
    )
      return result(
        "needs-review",
        "uncertain",
        "The loop can fit both 90 and 180 BPM.",
        scores,
      );
    const unpitched = aperiodicityEvidence(
      rms,
      dominant,
      blockFrames,
      strongest,
      8,
    );
    const spectrum = spectralEvidence(dominant, sampleRate);
    const lineFacts = context?.verifiedOfficialSource
      ? compatibleLineFacts(spectrum)
      : null;
    if (lineFacts && supportedBpm === 180)
      return result(
        "ready",
        "tonal-loop",
        "Persistent notes and attacks support use at 180 BPM.",
        { rhythm: rhythmScore, pitch: 0.6 },
        { ...tempoFacts, ...lineFacts },
      );
    if (!unpitched.supported || spectrum.tonalExclusion)
      return result(
        "needs-review",
        "uncertain",
        "The loop lacks sufficient unpitched audio evidence.",
        {
          rhythm: rhythmScore,
          pitch: unpitched.periodicityScore,
        },
        tempoFacts,
      );
    if (!tempoIsReady)
      return result(
        "needs-conversion",
        "key-neutral-loop",
        "Measured loop tempo needs conversion to 90 or 180 BPM.",
        scores,
        tempoFacts,
      );
    return result(
      "ready",
      "key-neutral-loop",
      "Measured key-neutral loop has a supported tempo.",
      scores,
      tempoFacts,
    );
  }
  if (pitched.length !== onsetBlocks.length)
    return result(
      "needs-review",
      "uncertain",
      "The source has mixed pitched and unpitched events.",
      scores,
      tempoFacts,
    );
  if (pitched.some((pitch) => pitch.pitchClass === null))
    return result(
      "needs-review",
      "uncertain",
      "Some pitched events do not have a stable musical note.",
      scores,
      tempoFacts,
    );

  const classes = new Set(pitched.map((pitch) => pitch.pitchClass!));
  const earlyToLate = onsetBlocks.map((block, index) => {
    const next = onsetBlocks[index + 1] ?? blockCount;
    const length = next - block;
    const early = Array.from(
      rms.slice(block + 1, block + Math.max(2, Math.floor(length * 0.25))),
    );
    const late = Array.from(
      rms.slice(
        block + Math.floor(length * 0.5),
        block + Math.floor(length * 0.75),
      ),
    );
    return early.length && late.length
      ? average(late) / (average(early) || 1)
      : 1;
  });
  const tuned =
    earlyToLate.filter((ratio) => ratio < 0.35).length >=
    onsetBlocks.length * 0.75;
  const kind: AnalyzedSampleKind = tuned ? "tuned-percussion" : "tonal-loop";
  const facts = compatibleFacts(classes);
  const correctedKey = context?.correction?.key;
  if (correctedKey?.mode === "major")
    return result(
      "needs-review",
      kind,
      "Major material stays in review. Select a compatible minor section.",
      scores,
      tempoFacts,
    );
  if (correctedKey && correctedKey.root !== 0) {
    // A pitch-class set cannot separate a minor key from its relative major.
    // The corrected root selects one reading when its minor form is complete.
    const transposition = minorKeyAt(classes, correctedKey.root);
    if (!transposition)
      return result(
        "needs-review",
        kind,
        "The measured notes do not establish the corrected minor key.",
        scores,
        tempoFacts,
      );
    return result(
      "needs-conversion",
      kind,
      tempoIsReady
        ? "Measured notes in the corrected minor key need transposition to C minor."
        : "Measured notes in the corrected minor key and loop tempo need conversion.",
      scores,
      { ...tempoFacts, ...transposition },
    );
  }
  if (!facts && correctedKey)
    return result(
      "needs-review",
      kind,
      "The measured notes do not fit the corrected key.",
      scores,
      tempoFacts,
    );
  if (!facts) {
    const transposition = otherMinorKey(
      classes,
      pitched[0]!.pitchClass!,
      pitched.at(-1)!.pitchClass!,
    );
    if (transposition)
      return result(
        "needs-conversion",
        kind,
        tempoIsReady
          ? "Measured minor notes need transposition to C minor."
          : "Measured minor notes and loop tempo need conversion.",
        scores,
        { ...tempoFacts, ...transposition },
      );
    return result(
      "needs-review",
      kind,
      "The notes do not establish one compatible C-minor form.",
      scores,
      tempoFacts,
    );
  }
  if (!tempoIsReady)
    return result(
      "needs-conversion",
      kind,
      "Measured loop tempo needs conversion to 90 or 180 BPM.",
      scores,
      { ...tempoFacts, ...facts },
    );
  return result(
    "ready",
    kind,
    "Measured C-minor notes and loop tempo are compatible.",
    scores,
    { ...tempoFacts, ...facts },
  );
}

/** Use verified provenance only when PCM checks find no musical contradiction. */
function sourceBackedCompatibility(decoded: DecodedWav): AudioAnalysis | null {
  const { sampleRate, frames, channels, loop } = decoded;
  if (
    !Number.isSafeInteger(frames) ||
    frames <= 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    channels.length !== 1 ||
    channels[0]!.length !== frames ||
    frames / sampleRate > MAX_ANALYSIS_SECONDS ||
    (loop && (loop.startFrame !== 0 || loop.endFrameExclusive !== frames))
  )
    return null;
  const duration = frames / sampleRate;
  const exactBeats = duration * 3;
  const beatCount = Math.round(exactBeats);
  const gridErrorBeats = Math.abs(exactBeats - beatCount);
  if (beatCount < 1 || beatCount > 84 || gridErrorBeats > 0.015) return null;

  const audio = channels[0]!;
  const blockFrames = Math.max(128, Math.round(sampleRate / 100));
  const blockCount = Math.ceil(frames / blockFrames);
  const rms = new Float32Array(blockCount);
  for (let block = 0; block < blockCount; block++) {
    const start = block * blockFrames;
    const end = Math.min(frames, start + blockFrames);
    let power = 0;
    for (let frame = start; frame < end; frame++) {
      const value = audio[frame]!;
      if (!Number.isFinite(value)) return null;
      power += value * value;
    }
    rms[block] = Math.sqrt(power / (end - start));
  }
  const peakRms = Math.max(...rms);
  if (peakRms < MIN_SIGNAL_RMS) return null;
  const edgeBlocks = Math.max(1, Math.floor(blockCount * 0.2));
  const head = average(Array.from(rms.slice(0, edgeBlocks)));
  const tail = average(Array.from(rms.slice(-edgeBlocks)));
  const decayRatio = head > 0 ? tail / head : Number.POSITIVE_INFINITY;
  const earlyPeakFraction = rms.indexOf(peakRms) / blockCount;
  const oneShotDecay = decayRatio < 0.3 && earlyPeakFraction < 0.4;

  const onsets: number[] = [];
  const minimumGap = Math.ceil((0.07 * sampleRate) / blockFrames);
  for (let block = 0; block < blockCount; block++) {
    const previous = block ? rms[block - 1]! : 0;
    if (
      rms[block]! >= peakRms * 0.2 &&
      rms[block]! - previous >= peakRms * 0.14 &&
      (!onsets.length || block - onsets.at(-1)! >= minimumGap)
    )
      onsets.push(block);
  }
  const spectrum = spectralEvidence(audio, sampleRate);
  if (
    spectrum.activeWindows < 2 ||
    spectrum.hardConflict ||
    spectrum.detuned ||
    spectrum.incompatible ||
    (spectrum.lineClasses.size > 0 &&
      compatibleForms(spectrum.lineClasses).length === 0)
  )
    return null;
  const evidence: SourceBackedEvidence = {
    gridErrorBeats,
    gridBeatsAt180: beatCount,
    attackCount: onsets.length,
    peakRms,
    activeSpectralWindows: spectrum.activeWindows,
    hardConflict: false,
    detuned: false,
    incompatibleClasses: false,
    incompatibleLines: false,
  };
  if (
    !loop &&
    duration <= 1.5 &&
    beatCount <= 4 &&
    oneShotDecay &&
    onsets.length >= 1 &&
    onsets.length <= 3
  )
    return result(
      "ready",
      "source-backed-one-shot",
      "Verified source context and measured one-shot decay support use.",
      { rhythm: 0, pitch: 0 },
      {
        sourceBackedEvidence: { ...evidence, earlyPeakFraction, decayRatio },
      },
    );
  if (beatCount < 4 || oneShotDecay || onsets.length < 2) return null;
  const rhythmScore = envelopeCorrelation(rms, sampleRate, blockFrames, 180);
  if (rhythmScore < 0.15) return null;
  if (onsets.length >= 4 && onsets.length <= MAX_ONSETS) {
    const intervals = onsets
      .slice(1)
      .map(
        (block, index) => ((block - onsets[index]!) * blockFrames) / sampleRate,
      );
    const mean = average(intervals);
    const jitter = Math.max(
      ...intervals.map((interval) => Math.abs(interval - mean) / mean),
    );
    const apparentBpm = 60 / mean;
    if (
      jitter < 0.06 &&
      Math.abs(apparentBpm - 90) > 2 &&
      Math.abs(apparentBpm - 180) > 2 &&
      Math.abs(apparentBpm - 360) > 4
    )
      return null;
  }
  return result(
    "ready",
    "source-backed-compatible-loop",
    "Verified source context and measured 180 BPM rhythm support use.",
    { rhythm: rhythmScore, pitch: 0 },
    {
      bpm: 180,
      beatCount,
      sourceBackedEvidence: {
        ...evidence,
        envelopeCorrelation180: rhythmScore,
      },
    },
  );
}

/** Keep tempo facts only. Other facts of a held result are not claims. */
function heldForCorrection(analysis: AudioAnalysis, reason: string) {
  const { sampleKind, bpm, estimatedBpm, beatCount, detectorScores } =
    analysis.measured;
  return {
    algorithmVersion: AUDIO_ANALYSIS_VERSION,
    status: "needs-review" as const,
    measured: {
      sampleKind: sampleKind.startsWith("source-backed-")
        ? ("uncertain" as const)
        : sampleKind,
      ...(bpm !== undefined ? { bpm } : {}),
      ...(estimatedBpm !== undefined ? { estimatedBpm } : {}),
      ...(beatCount !== undefined ? { beatCount } : {}),
      detectorScores,
    },
    reasons: [reason],
  };
}

/**
 * Hold a result that a correction contradicts. A correction never removes a
 * measurement check, so an unresolved review result stays unchanged.
 */
function checkCorrection(
  analysis: AudioAnalysis,
  correction: AnalysisCorrection,
): AudioAnalysis {
  if (analysis.status === "needs-review")
    return {
      ...analysis,
      reasons: [
        ...analysis.reasons,
        "The correction does not resolve this measured result.",
      ].slice(0, 16),
    };
  const measured = analysis.measured;
  const kind = measured.sampleKind;
  const pitched = kind === "tonal-loop" || kind === "tuned-percussion";
  const neutral = kind === "key-neutral-loop" || kind === "unpitched-one-shot";
  if (correction.bpm !== undefined) {
    if (measured.bpm === undefined)
      return heldForCorrection(
        analysis,
        "A one-shot has no source tempo. The tempo correction does not apply.",
      );
    if (Math.abs(measured.bpm - correction.bpm) > TEMPO_TOLERANCE_BPM)
      return heldForCorrection(
        analysis,
        "The corrected tempo does not agree with the measured attacks.",
      );
  }
  if (correction.tonalClass === "key-neutral" && pitched)
    return heldForCorrection(
      analysis,
      "Measured notes contradict the key-neutral correction.",
    );
  if (correction.tonalClass === "tonal" && neutral)
    return heldForCorrection(
      analysis,
      "No stable notes were measured for the tonal correction.",
    );
  const key = correction.key;
  if (key) {
    if (neutral)
      return heldForCorrection(
        analysis,
        "Key-neutral audio has no musical key. The key correction does not apply.",
      );
    if (key.mode === "major")
      return heldForCorrection(
        analysis,
        "Major material stays in review. Select a compatible minor section.",
      );
    const root = measured.sourceKey?.root ?? 0;
    if (key.root !== root)
      return heldForCorrection(
        analysis,
        "The corrected key does not agree with the measured notes.",
      );
  }
  return {
    ...analysis,
    reasons: [
      ...analysis.reasons,
      "The user correction agrees with the measured result.",
    ].slice(0, 16),
  };
}

export function analyzeAudio(
  decoded: DecodedWav,
  context?: AudioAnalysisContext,
): AudioAnalysis {
  const measured = analyzeMeasuredAudio(decoded, context);
  const combined =
    !context?.verifiedOfficialSource || measured.status !== "needs-review"
      ? measured
      : (sourceBackedCompatibility(decoded) ?? measured);
  return context?.correction
    ? checkCorrection(combined, context.correction)
    : combined;
}
