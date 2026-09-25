import type {
  AudioAnalysis,
  AudioMeasurements,
  SourceBackedEvidence,
} from "../audio/analyze.ts";
import { nearestShiftToC } from "./music.ts";
import type { WavInfo } from "./wav.ts";
import { validateSamplePath } from "./project.ts";
import {
  regionProblem,
  validCorrectedBpm,
  type SourceRegion,
  type TonalClass,
} from "./review.ts";

export const AUDIO_MANIFEST_FILENAME = "ravefold-analysis.manifest.json";
export const MAX_AUDIO_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_RECORDS = 20_000;
const ANALYSIS_VERSIONS: readonly AudioAnalysis["algorithmVersion"][] = [
  "audio-analysis-v2",
  "audio-analysis-v3",
];

export interface DeclaredAudio {
  source: "og-collection" | "file" | "user";
  bpm: number | null;
  key: string | null;
}

/** User input for a review, stored apart from declared and measured values. */
export interface CorrectedAudio {
  bpm: number | null;
  key: string | null;
  tonalClass?: TonalClass | null;
  /** A selected section of the unchanged source. */
  region?: SourceRegion | null;
}

export interface AudioRecord {
  sourceSha256: string;
  sourceBytes: number;
  wav: WavInfo;
  declared: DeclaredAudio | null;
  /** The detector result without user corrections. */
  measured: AudioAnalysis;
  corrected: CorrectedAudio | null;
  /**
   * Validation of the corrected input. It analyzes the region when the
   * correction has one. A region result never changes the source status.
   */
  reviewed?: AudioAnalysis;
}

export interface AudioManifest {
  schemaVersion: 1;
  revision: number;
  samples: Record<string, AudioRecord>;
}

const C_MINOR_FORMS = {
  natural: [0, 2, 3, 5, 7, 8, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
  melodic: [0, 2, 3, 5, 7, 9, 11],
} as const;

type MinorForm = keyof typeof C_MINOR_FORMS;
const MINOR_FORM_ORDER: readonly MinorForm[] = [
  "natural",
  "harmonic",
  "melodic",
];

function measuredCompatibility(
  classesValue: unknown,
  formsValue: unknown,
): { classes?: number[]; forms?: MinorForm[] } {
  if (classesValue === undefined && formsValue === undefined) return {};
  if (
    !Array.isArray(classesValue) ||
    classesValue.length === 0 ||
    classesValue.length > 12 ||
    classesValue.some(
      (value, index) =>
        !Number.isInteger(value) ||
        value < 0 ||
        value > 11 ||
        (index > 0 && value <= classesValue[index - 1]),
    )
  )
    throw new Error("Measured pitch classes must be sorted and unique.");
  const classes = classesValue as number[];
  const expected = MINOR_FORM_ORDER.filter((form) =>
    classes.every((value) =>
      (C_MINOR_FORMS[form] as readonly number[]).includes(value),
    ),
  );
  if (
    !Array.isArray(formsValue) ||
    formsValue.length === 0 ||
    formsValue.length !== expected.length ||
    formsValue.some((value, index) => value !== expected[index])
  )
    throw new Error("Measured minor forms do not match the pitch classes.");
  return { classes: [...classes], forms: expected };
}

/** The degrees that establish each form, in addition to the tonic triad. */
const FORM_DEGREES: Record<MinorForm, readonly number[]> = {
  natural: [8, 10],
  harmonic: [8, 11],
  melodic: [9, 11],
};

function measuredTransposition(
  keyValue: unknown,
  shiftValue: unknown,
): Pick<AudioMeasurements, "sourceKey" | "transposeSemitones"> | undefined {
  if (keyValue === undefined && shiftValue === undefined) return undefined;
  const data = object(keyValue, ["root", "minorForm", "pitchClasses"]);
  const root = whole(data.root, 1, "Source key root");
  const form = MINOR_FORM_ORDER.find((name) => name === data.minorForm);
  const classes = data.pitchClasses;
  if (
    root > 11 ||
    !form ||
    !Array.isArray(classes) ||
    classes.length < 5 ||
    classes.length > 7 ||
    classes.some(
      (value, index) =>
        !Number.isInteger(value) ||
        value < 0 ||
        value > 11 ||
        (index > 0 && value <= classes[index - 1]),
    )
  )
    throw new Error("The measured source key is invalid.");
  const shifted = new Set(
    (classes as number[]).map((value) => (value - root + 12) % 12),
  );
  const notes: readonly number[] = C_MINOR_FORMS[form];
  if (
    ![0, 3, 7, ...FORM_DEGREES[form]].every((note) => shifted.has(note)) ||
    [...shifted].some((note) => !notes.includes(note))
  )
    throw new Error("The measured source key does not match its notes.");
  if (shiftValue !== nearestShiftToC(root))
    throw new Error("The transposition is not the nearest shift to C.");
  return {
    sourceKey: { root, minorForm: form, pitchClasses: [...classes] },
    transposeSemitones: shiftValue,
  };
}

function sourceBackedEvidence(
  value: unknown,
  kind: "source-backed-compatible-loop" | "source-backed-one-shot",
): SourceBackedEvidence {
  const isLoop = kind === "source-backed-compatible-loop";
  const data = object(value, [
    "gridErrorBeats",
    "gridBeatsAt180",
    "attackCount",
    "peakRms",
    "activeSpectralWindows",
    "hardConflict",
    "detuned",
    "incompatibleClasses",
    "incompatibleLines",
    ...(isLoop
      ? ["envelopeCorrelation180"]
      : ["earlyPeakFraction", "decayRatio"]),
  ]);
  const gridErrorBeats = finite(data.gridErrorBeats, 0, "Grid error");
  const gridBeatsAt180 = whole(data.gridBeatsAt180, 1, "Grid beat count");
  const attackCount = whole(data.attackCount, 0, "Attack count");
  const peakRms = finite(data.peakRms, 0.008, "Peak level");
  const activeSpectralWindows = whole(
    data.activeSpectralWindows,
    2,
    "Active spectral windows",
  );
  if (
    gridErrorBeats > 0.015 ||
    activeSpectralWindows > 16 ||
    data.hardConflict !== false ||
    data.detuned !== false ||
    data.incompatibleClasses !== false ||
    data.incompatibleLines !== false
  )
    throw new Error("Source-backed audio has invalid measured evidence.");
  if (isLoop) {
    const envelopeCorrelation180 = finite(
      data.envelopeCorrelation180,
      0.15,
      "180 BPM envelope correlation",
    );
    if (
      gridBeatsAt180 < 4 ||
      gridBeatsAt180 > 84 ||
      attackCount < 2 ||
      envelopeCorrelation180 > 1
    )
      throw new Error("The source-backed loop evidence is invalid.");
    return {
      gridErrorBeats,
      gridBeatsAt180,
      attackCount,
      peakRms,
      activeSpectralWindows,
      hardConflict: false,
      detuned: false,
      incompatibleClasses: false,
      incompatibleLines: false,
      envelopeCorrelation180,
    };
  }
  const earlyPeakFraction = finite(
    data.earlyPeakFraction,
    0,
    "Early peak position",
  );
  const decayRatio = finite(data.decayRatio, 0, "Decay ratio");
  if (
    gridBeatsAt180 > 4 ||
    attackCount < 1 ||
    attackCount > 3 ||
    earlyPeakFraction >= 0.4 ||
    decayRatio >= 0.3
  )
    throw new Error("The source-backed one-shot evidence is invalid.");
  return {
    gridErrorBeats,
    gridBeatsAt180,
    attackCount,
    peakRms,
    activeSpectralWindows,
    hardConflict: false,
    detuned: false,
    incompatibleClasses: false,
    incompatibleLines: false,
    earlyPeakFraction,
    decayRatio,
  };
}

function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Analysis metadata must be an object.");
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (
    required.some((key) => !Object.hasOwn(fields, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new Error("Analysis metadata has missing or unsupported fields.");
  return fields;
}

function whole(value: unknown, minimum: number, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new Error(`${label} must be a valid whole number.`);
  return value;
}

function finite(value: unknown, minimum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum)
    throw new Error(`${label} must be a finite number.`);
  return value;
}

function key(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^[A-G](?:#|b)? (?:major|minor)$/u.test(value)
  )
    throw new Error("The declared or corrected key is invalid.");
  return value;
}

function bpm(value: unknown): number | null {
  return value === null ? null : finite(value, Number.EPSILON, "Tempo");
}

export function validateDeclaredAudio(value: unknown): DeclaredAudio | null {
  if (value === null) return null;
  const data = object(value, ["source", "bpm", "key"]);
  if (
    data.source !== "og-collection" &&
    data.source !== "file" &&
    data.source !== "user"
  )
    throw new Error("The declaration source is invalid.");
  return { source: data.source, bpm: bpm(data.bpm), key: key(data.key) };
}

function region(value: unknown): SourceRegion {
  const data = object(value, ["startFrame", "endFrameExclusive"]);
  return {
    startFrame: whole(data.startFrame, 0, "Region start"),
    endFrameExclusive: whole(data.endFrameExclusive, 1, "Region end"),
  };
}

export function validateCorrectedAudio(value: unknown): CorrectedAudio | null {
  if (value === null) return null;
  const data = object(value, ["bpm", "key"], ["tonalClass", "region"]);
  const corrected = { bpm: bpm(data.bpm), key: key(data.key) };
  if (corrected.bpm !== null && !validCorrectedBpm(corrected.bpm))
    throw new Error("The corrected tempo is outside the supported range.");
  if (
    data.tonalClass !== undefined &&
    data.tonalClass !== null &&
    data.tonalClass !== "tonal" &&
    data.tonalClass !== "key-neutral"
  )
    throw new Error("The corrected tonal class is invalid.");
  if (data.tonalClass === "key-neutral" && corrected.key !== null)
    throw new Error("A key-neutral correction cannot have a key.");
  return {
    ...corrected,
    ...(data.tonalClass !== undefined ? { tonalClass: data.tonalClass } : {}),
    ...(data.region !== undefined
      ? { region: data.region === null ? null : region(data.region) }
      : {}),
  };
}

export function validateWavInfo(value: unknown): WavInfo {
  const data = object(
    value,
    ["encoding", "channels", "sampleRate", "frames", "duration"],
    ["loop"],
  );
  if (
    data.encoding !== "pcm16" &&
    data.encoding !== "pcm24" &&
    data.encoding !== "float32"
  )
    throw new Error("The WAV encoding is invalid.");
  if (data.channels !== 1 && data.channels !== 2)
    throw new Error("The WAV channel count is invalid.");
  const sampleRate = whole(data.sampleRate, 1, "Sample rate");
  const frames = whole(data.frames, 1, "Frame count");
  const duration = finite(data.duration, Number.EPSILON, "Duration");
  if (Math.abs(duration - frames / sampleRate) > 1e-9)
    throw new Error("The WAV duration does not match its frames.");
  let loop: WavInfo["loop"];
  if (data.loop !== undefined) {
    const marks = object(data.loop, ["startFrame", "endFrameExclusive"]);
    const startFrame = whole(marks.startFrame, 0, "Loop start");
    const endFrameExclusive = whole(marks.endFrameExclusive, 1, "Loop end");
    if (endFrameExclusive <= startFrame || endFrameExclusive > frames)
      throw new Error("The WAV loop region is invalid.");
    loop = { startFrame, endFrameExclusive };
  }
  return {
    encoding: data.encoding,
    channels: data.channels,
    sampleRate,
    frames,
    duration,
    ...(loop ? { loop } : {}),
  };
}

function analysis(value: unknown): AudioAnalysis {
  const data = object(value, [
    "algorithmVersion",
    "status",
    "measured",
    "reasons",
  ]);
  const algorithmVersion = ANALYSIS_VERSIONS.find(
    (version) => version === data.algorithmVersion,
  );
  if (!algorithmVersion)
    throw new Error("The audio analysis version is not supported.");
  if (
    data.status !== "ready" &&
    data.status !== "needs-conversion" &&
    data.status !== "needs-review"
  )
    throw new Error("The audio analysis status is invalid.");
  const values = object(
    data.measured,
    ["sampleKind", "detectorScores"],
    [
      "bpm",
      "estimatedBpm",
      "beatCount",
      "key",
      "minorForm",
      "compatiblePitchClasses",
      "compatibleMinorForms",
      "sourceBackedEvidence",
      "sourceKey",
      "transposeSemitones",
    ],
  );
  if (
    values.sampleKind !== "unpitched-one-shot" &&
    values.sampleKind !== "key-neutral-loop" &&
    values.sampleKind !== "tonal-loop" &&
    values.sampleKind !== "tuned-percussion" &&
    values.sampleKind !== "source-backed-compatible-loop" &&
    values.sampleKind !== "source-backed-one-shot" &&
    values.sampleKind !== "uncertain"
  )
    throw new Error("The sample class is invalid.");
  const scores = object(values.detectorScores, ["rhythm", "pitch"]);
  const rhythm = finite(scores.rhythm, 0, "Rhythm score");
  const pitch = finite(scores.pitch, 0, "Pitch score");
  if (rhythm > 1 || pitch > 1)
    throw new Error("Detector scores must be between zero and one.");
  const sourceBpm =
    values.bpm === undefined
      ? undefined
      : finite(values.bpm, Number.EPSILON, "Source tempo");
  const estimatedBpm =
    values.estimatedBpm === undefined
      ? undefined
      : finite(values.estimatedBpm, Number.EPSILON, "Estimated tempo");
  const beatCount =
    values.beatCount === undefined
      ? undefined
      : finite(values.beatCount, Number.EPSILON, "Beat count");
  if (values.key !== undefined && values.key !== "C")
    throw new Error("The measured key is invalid.");
  if (
    values.minorForm !== undefined &&
    values.minorForm !== "natural" &&
    values.minorForm !== "harmonic" &&
    values.minorForm !== "melodic"
  )
    throw new Error("The measured minor form is invalid.");
  const compatibility = measuredCompatibility(
    values.compatiblePitchClasses,
    values.compatibleMinorForms,
  );
  const backedKind =
    values.sampleKind === "source-backed-compatible-loop" ||
    values.sampleKind === "source-backed-one-shot";
  if (!backedKind && values.sourceBackedEvidence !== undefined)
    throw new Error(
      "Only source-backed audio can have source-backed evidence.",
    );
  if (backedKind && data.status !== "ready")
    throw new Error("A source-backed result must pass all readiness checks.");
  const backed =
    values.sampleKind === "source-backed-compatible-loop" ||
    values.sampleKind === "source-backed-one-shot"
      ? sourceBackedEvidence(values.sourceBackedEvidence, values.sampleKind)
      : undefined;
  const transposition = measuredTransposition(
    values.sourceKey,
    values.transposeSemitones,
  );
  if (
    transposition &&
    (data.status !== "needs-conversion" ||
      (values.sampleKind !== "tonal-loop" &&
        values.sampleKind !== "tuned-percussion") ||
      values.key !== undefined ||
      values.minorForm !== undefined ||
      compatibility.classes !== undefined ||
      sourceBpm === undefined ||
      beatCount === undefined)
  )
    throw new Error("Only a tonal conversion result can have a source key.");
  const reasons = data.reasons;
  if (
    !Array.isArray(reasons) ||
    reasons.length > 16 ||
    reasons.some(
      (reason) =>
        typeof reason !== "string" ||
        !reason ||
        reason.length > 240 ||
        /[\u0000-\u001f\u007f]/u.test(reason),
    )
  )
    throw new Error("The analysis reasons are invalid.");
  if (data.status !== "ready" && reasons.length === 0)
    throw new Error("A sample that is not ready needs a reason.");
  if (data.status === "ready") {
    if (values.sampleKind === "uncertain")
      throw new Error("An uncertain sample cannot be ready.");
    if (backedKind) {
      if (!backed) throw new Error("Source-backed evidence is missing.");
      if (
        values.key !== undefined ||
        values.minorForm !== undefined ||
        compatibility.classes !== undefined ||
        estimatedBpm !== undefined ||
        pitch !== 0 ||
        (values.sampleKind === "source-backed-compatible-loop" &&
          (sourceBpm !== 180 ||
            beatCount !== backed.gridBeatsAt180 ||
            rhythm !== backed.envelopeCorrelation180)) ||
        (values.sampleKind === "source-backed-one-shot" &&
          (sourceBpm !== undefined || beatCount !== undefined || rhythm !== 0))
      )
        throw new Error("Source-backed audio has an invalid ready result.");
    } else if (values.sampleKind === "unpitched-one-shot") {
      if (
        sourceBpm !== undefined ||
        estimatedBpm !== undefined ||
        values.key !== undefined ||
        values.minorForm !== undefined ||
        compatibility.classes !== undefined
      )
        throw new Error("An unpitched one-shot cannot have a tempo or key.");
    } else if (values.sampleKind === "key-neutral-loop") {
      if (
        (sourceBpm !== 90 && sourceBpm !== 180) ||
        values.key !== undefined ||
        values.minorForm !== undefined ||
        compatibility.classes !== undefined
      )
        throw new Error("A key-neutral loop needs 90 or 180 BPM and no key.");
    } else if (
      compatibility.classes === undefined ||
      compatibility.forms === undefined ||
      pitch === 0 ||
      (values.key === "C") !== (values.minorForm !== undefined) ||
      (values.minorForm !== undefined &&
        (compatibility.forms.length !== 1 ||
          compatibility.forms[0] !== values.minorForm)) ||
      (values.sampleKind === "tonal-loop" &&
        sourceBpm !== 90 &&
        sourceBpm !== 180) ||
      (sourceBpm !== undefined && sourceBpm !== 90 && sourceBpm !== 180)
    ) {
      throw new Error(
        "Ready tonal audio needs compatible measured notes and tempo.",
      );
    }
  }
  return {
    algorithmVersion,
    status: data.status,
    measured: {
      sampleKind: values.sampleKind,
      ...(sourceBpm !== undefined ? { bpm: sourceBpm } : {}),
      ...(estimatedBpm !== undefined ? { estimatedBpm } : {}),
      ...(beatCount !== undefined ? { beatCount } : {}),
      ...(values.key === "C" ? { key: "C" as const } : {}),
      ...(values.minorForm !== undefined
        ? { minorForm: values.minorForm }
        : {}),
      ...(compatibility.classes
        ? { compatiblePitchClasses: compatibility.classes }
        : {}),
      ...(compatibility.forms
        ? { compatibleMinorForms: compatibility.forms }
        : {}),
      ...(backed ? { sourceBackedEvidence: backed } : {}),
      ...(transposition ?? {}),
      detectorScores: { rhythm, pitch },
    },
    reasons: [...reasons] as string[],
  };
}

export function validateAudioRecord(value: unknown): AudioRecord {
  const data = object(
    value,
    ["sourceSha256", "sourceBytes", "wav", "declared", "measured", "corrected"],
    ["reviewed"],
  );
  if (
    typeof data.sourceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(data.sourceSha256)
  )
    throw new Error("The source hash is invalid.");
  const sourceBytes = whole(data.sourceBytes, 1, "Source byte count");
  const wav = validateWavInfo(data.wav);
  const bytesPerFrame =
    wav.channels *
    (wav.encoding === "pcm24" ? 3 : wav.encoding === "pcm16" ? 2 : 4);
  if (sourceBytes < 44 + wav.frames * bytesPerFrame)
    throw new Error("The source byte count cannot contain the WAV frames.");
  const declared = validateDeclaredAudio(data.declared);
  const measured = analysis(data.measured);
  const backed = measured.measured.sourceBackedEvidence;
  if (backed) {
    if (
      declared?.source !== "og-collection" ||
      declared.bpm !== 180 ||
      declared.key !== "C minor"
    )
      throw new Error("Source-backed audio needs a separate OG declaration.");
    const gridError = Math.abs(wav.duration * 3 - backed.gridBeatsAt180);
    if (
      gridError > 0.015 + 1e-9 ||
      Math.abs(gridError - backed.gridErrorBeats) > 1e-6 ||
      (wav.loop &&
        (wav.loop.startFrame !== 0 ||
          wav.loop.endFrameExclusive !== wav.frames)) ||
      (measured.measured.sampleKind === "source-backed-one-shot" &&
        (wav.duration > 1.5 || wav.loop !== undefined))
    )
      throw new Error("Source-backed evidence does not match the WAV file.");
  }
  const corrected = validateCorrectedAudio(data.corrected);
  if (corrected?.region) {
    const problem = regionProblem(corrected.region, wav);
    if (problem) throw new Error(problem);
  }
  let reviewed: AudioAnalysis | undefined;
  if (data.reviewed !== undefined) {
    reviewed = analysis(data.reviewed);
    if (!corrected)
      throw new Error("A review result needs the corrected input.");
    // Review validation does not use a source record, so its result cannot
    // be source-backed.
    if (reviewed.measured.sampleKind.startsWith("source-backed-"))
      throw new Error("A review result cannot be source-backed.");
  }
  return {
    sourceSha256: data.sourceSha256,
    sourceBytes,
    wav,
    declared,
    measured,
    corrected,
    ...(reviewed ? { reviewed } : {}),
  };
}

export function emptyAudioManifest(): AudioManifest {
  return { schemaVersion: 1, revision: 0, samples: {} };
}

export function validateAudioManifest(value: unknown): AudioManifest {
  const data = object(value, ["schemaVersion", "revision", "samples"]);
  if (data.schemaVersion !== 1)
    throw new Error("The analysis manifest version is not supported.");
  const revision = whole(data.revision, 0, "Manifest revision");
  if (
    !data.samples ||
    typeof data.samples !== "object" ||
    Array.isArray(data.samples)
  )
    throw new Error("The analysis samples are invalid.");
  const entries = Object.entries(data.samples);
  if (entries.length > MAX_AUDIO_RECORDS)
    throw new Error("The analysis manifest has too many samples.");
  const samples: AudioManifest["samples"] = {};
  for (const [path, row] of entries)
    samples[validateSamplePath(path)] = validateAudioRecord(row);
  return { schemaVersion: 1, revision, samples };
}

export function parseAudioManifest(source: string): AudioManifest {
  if (new TextEncoder().encode(source).byteLength > MAX_AUDIO_MANIFEST_BYTES)
    throw new Error("The analysis manifest is too large.");
  return validateAudioManifest(JSON.parse(source));
}
