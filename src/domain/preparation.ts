import type { AudioAnalysis } from "../audio/analyze.ts";
import { validateAudioRecord, validateWavInfo } from "./audio-manifest.ts";
import {
  nearestSupportedBpm,
  SUPPORTED_BPMS,
  type SupportedBpm,
} from "./music.ts";
import { validateSamplePath } from "./project.ts";
import type { WavInfo } from "./wav.ts";

export const PREPARATION_MANIFEST_FILENAME =
  "ravefold-preparation.manifest.json";
export const MAX_PREPARATION_MANIFEST_BYTES = 8 * 1024 * 1024;
export const PREPARED_FOLDER = "RaveFold prepared";
/** The processor name changes when output audio for equal inputs can change. */
export const PREPARATION_PROCESSOR =
  "stretch-resample-v1 (signalsmith-stretch 1.3.2)";
const MAX_JOBS = 10_000;
const MAX_KEPT_OUTPUTS = 100;
const MIN_STRETCH_RATIO = 0.25;
const MAX_STRETCH_RATIO = 4;
const hashPattern = /^[0-9a-f]{64}$/u;
const sessionPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type PreparedKind =
  "key-neutral-loop" | "tonal-loop" | "tuned-percussion";

export interface PreparationPlan {
  sampleKind: PreparedKind;
  sourceBpm: number;
  targetBpm: SupportedBpm;
  beatCount: number;
  semitones: number;
  sampleRate: number;
  channels: 1 | 2;
  inputFrames: number;
  outputFrames: number;
  loop: boolean;
  /** Compatible C-minor pitch classes that the output must measure. */
  expectedPitchClasses: number[] | null;
}

export type PreparationPhase =
  | "queued"
  | "analysis"
  | "conversion"
  | "validation"
  | "ready"
  | "review"
  | "failed"
  | "cancelled";

export const ACTIVE_PHASES: readonly PreparationPhase[] = [
  "analysis",
  "conversion",
  "validation",
];

export interface PreparationSource {
  path: string;
  sourceSha256: string;
  sourceBytes: number;
  wav: WavInfo;
}

export interface PreparationMeasurements {
  stretchRatio: number;
  pitchRatio: number;
  latencyFrames: number;
  peak: number;
}

export interface PreparationOutput {
  path: string;
  sha256: string;
  bytes: number;
  wav: WavInfo;
  analysis: AudioAnalysis;
  measurements: PreparationMeasurements;
}

/** A session holds an active job until the lease expires. */
export interface PreparationLease {
  session: string;
  expiresAt: number;
}

export interface PreparationJob {
  id: string;
  source: PreparationSource;
  plan: PreparationPlan;
  processor: typeof PREPARATION_PROCESSOR;
  phase: PreparationPhase;
  attempt: number;
  outputPath: string | null;
  /** Earlier output paths. Partial and unused audio at these paths stays. */
  keptOutputs: string[];
  lease: PreparationLease | null;
  output: PreparationOutput | null;
  message: string;
  updatedAt: number;
}

export interface PreparationManifest {
  schemaVersion: 1;
  revision: number;
  jobs: Record<string, PreparationJob>;
}

export type PlanResult =
  { valid: true; plan: PreparationPlan } | { valid: false; reason: string };

/** Select tempo and pitch changes from measured values only. */
export function planPreparation(
  analysis: AudioAnalysis,
  wav: WavInfo,
): PlanResult {
  const fail = (reason: string): PlanResult => ({ valid: false, reason });
  const measured = analysis.measured;
  if (analysis.status === "ready")
    return fail("This sample is ready. It needs no conversion.");
  if (analysis.status !== "needs-conversion")
    return fail("This sample needs review. Preparation cannot resolve it.");
  const kind = measured.sampleKind;
  if (
    kind !== "key-neutral-loop" &&
    kind !== "tonal-loop" &&
    kind !== "tuned-percussion"
  )
    return fail("Only measured loops can be prepared.");
  const bpm = measured.bpm;
  const beatCount = measured.beatCount;
  if (
    bpm === undefined ||
    !Number.isFinite(bpm) ||
    bpm <= 0 ||
    beatCount === undefined ||
    !Number.isSafeInteger(beatCount) ||
    beatCount < 1
  )
    return fail("The measured tempo is not sufficient for preparation.");
  const targetBpm = SUPPORTED_BPMS.find((value) => value === bpm)
    ? (bpm as SupportedBpm)
    : nearestSupportedBpm(bpm);
  const semitones =
    kind === "key-neutral-loop" ? 0 : (measured.transposeSemitones ?? 0);
  let expectedPitchClasses: number[] | null = null;
  if (kind !== "key-neutral-loop") {
    const classes =
      measured.sourceKey?.pitchClasses ?? measured.compatiblePitchClasses;
    if (!classes?.length)
      return fail("The measured notes are not sufficient for preparation.");
    expectedPitchClasses = [
      ...new Set(classes.map((value) => (value + semitones + 12) % 12)),
    ].sort((a, b) => a - b);
  }
  const outputFrames = Math.round(
    (beatCount * 60 * wav.sampleRate) / targetBpm,
  );
  if (outputFrames === wav.frames && semitones === 0)
    return fail("This sample needs no tempo or pitch change.");
  const ratio = (outputFrames * 2 ** (semitones / 12)) / wav.frames;
  if (ratio < MIN_STRETCH_RATIO || ratio > MAX_STRETCH_RATIO)
    return fail("The tempo change is outside the supported conversion range.");
  return {
    valid: true,
    plan: {
      sampleKind: kind,
      sourceBpm: bpm,
      targetBpm,
      beatCount,
      semitones,
      sampleRate: wav.sampleRate,
      channels: wav.channels,
      inputFrames: wav.frames,
      outputFrames,
      loop: wav.loop !== undefined,
      expectedPitchClasses,
    },
  };
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Equal source content, region and parameters give one job ID. */
export async function preparationJobId(
  sourceSha256: string,
  plan: PreparationPlan,
): Promise<string> {
  const key = [
    sourceSha256,
    `0-${plan.inputFrames}`,
    plan.targetBpm,
    plan.beatCount,
    plan.semitones,
    plan.outputFrames,
    PREPARATION_PROCESSOR,
  ].join("\u0000");
  return hex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
  );
}

/** Give the relative output path for one attempt number. */
export function preparedOutputPath(
  sourcePath: string,
  plan: PreparationPlan,
  index: number,
): string {
  const segments = validateSamplePath(sourcePath).split("/");
  const stem = segments.pop()!.replace(/\.wav$/iu, "");
  const pitch = plan.semitones
    ? ` ${plan.semitones > 0 ? "+" : ""}${plan.semitones} st`
    : "";
  const suffix = index === 1 ? "" : ` (${index})`;
  return validateSamplePath(
    [
      PREPARED_FOLDER,
      ...segments,
      `${stem} ${plan.targetBpm} BPM${pitch}${suffix}.wav`,
    ].join("/"),
  );
}

function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Preparation metadata must be an object.");
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== keys.length ||
    Object.keys(data).some((key) => !keys.includes(key))
  )
    throw new Error("Preparation metadata has missing or unsupported fields.");
  return data;
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

function message(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 480 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error("The preparation message is invalid.");
  return value;
}

function pitchClasses(value: unknown): number[] | null {
  if (value === null) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 12 ||
    value.some(
      (item, index) =>
        !Number.isInteger(item) ||
        item < 0 ||
        item > 11 ||
        (index > 0 && item <= value[index - 1]),
    )
  )
    throw new Error("Expected pitch classes must be sorted and unique.");
  return [...(value as number[])];
}

export function validatePreparationPlan(value: unknown): PreparationPlan {
  const data = object(value, [
    "sampleKind",
    "sourceBpm",
    "targetBpm",
    "beatCount",
    "semitones",
    "sampleRate",
    "channels",
    "inputFrames",
    "outputFrames",
    "loop",
    "expectedPitchClasses",
  ]);
  const kind = data.sampleKind;
  if (
    kind !== "key-neutral-loop" &&
    kind !== "tonal-loop" &&
    kind !== "tuned-percussion"
  )
    throw new Error("The prepared sample class is invalid.");
  const targetBpm = SUPPORTED_BPMS.find((bpm) => bpm === data.targetBpm);
  if (!targetBpm) throw new Error("The target tempo must be 90 or 180 BPM.");
  const sourceBpm = finite(data.sourceBpm, Number.EPSILON, "Source tempo");
  const beatCount = whole(data.beatCount, 1, "Beat count");
  const semitones = data.semitones;
  if (
    typeof semitones !== "number" ||
    !Number.isInteger(semitones) ||
    semitones < -6 ||
    semitones > 5 ||
    (kind === "key-neutral-loop" && semitones !== 0)
  )
    throw new Error("The pitch change is invalid.");
  const sampleRate = whole(data.sampleRate, 8000, "Sample rate");
  if (data.channels !== 1 && data.channels !== 2)
    throw new Error("The prepared channel count is invalid.");
  const inputFrames = whole(data.inputFrames, 1, "Input frames");
  const outputFrames = whole(data.outputFrames, 1, "Output frames");
  if (outputFrames !== Math.round((beatCount * 60 * sampleRate) / targetBpm))
    throw new Error("The output length does not keep the source beat count.");
  if (typeof data.loop !== "boolean")
    throw new Error("The loop setting is invalid.");
  const expected = pitchClasses(data.expectedPitchClasses);
  if ((kind === "key-neutral-loop") !== (expected === null))
    throw new Error("Only tonal material has expected pitch classes.");
  return {
    sampleKind: kind,
    sourceBpm,
    targetBpm,
    beatCount,
    semitones,
    sampleRate,
    channels: data.channels,
    inputFrames,
    outputFrames,
    loop: data.loop,
    expectedPitchClasses: expected,
  };
}

function source(value: unknown): PreparationSource {
  const data = object(value, ["path", "sourceSha256", "sourceBytes", "wav"]);
  if (
    typeof data.sourceSha256 !== "string" ||
    !hashPattern.test(data.sourceSha256)
  )
    throw new Error("The preparation source hash is invalid.");
  return {
    path: validateSamplePath(data.path),
    sourceSha256: data.sourceSha256,
    sourceBytes: whole(data.sourceBytes, 44, "Source byte count"),
    wav: validateWavInfo(data.wav),
  };
}

function output(value: unknown): PreparationOutput {
  const data = object(value, [
    "path",
    "sha256",
    "bytes",
    "wav",
    "analysis",
    "measurements",
  ]);
  const path = validateSamplePath(data.path);
  if (typeof data.sha256 !== "string" || !hashPattern.test(data.sha256))
    throw new Error("The prepared output hash is invalid.");
  const bytes = whole(data.bytes, 44, "Output byte count");
  const record = validateAudioRecord({
    sourceSha256: data.sha256,
    sourceBytes: bytes,
    wav: data.wav,
    declared: null,
    measured: data.analysis,
    corrected: null,
  });
  const values = object(data.measurements, [
    "stretchRatio",
    "pitchRatio",
    "latencyFrames",
    "peak",
  ]);
  const peak = finite(values.peak, 0, "Output peak");
  if (peak > 4) throw new Error("The prepared output level is not plausible.");
  return {
    path,
    sha256: data.sha256,
    bytes,
    wav: record.wav,
    analysis: record.measured,
    measurements: {
      stretchRatio: finite(
        values.stretchRatio,
        Number.EPSILON,
        "Stretch ratio",
      ),
      pitchRatio: finite(values.pitchRatio, Number.EPSILON, "Pitch ratio"),
      latencyFrames: whole(values.latencyFrames, 0, "Latency"),
      peak,
    },
  };
}

function lease(value: unknown): PreparationLease | null {
  if (value === null) return null;
  const data = object(value, ["session", "expiresAt"]);
  if (typeof data.session !== "string" || !sessionPattern.test(data.session))
    throw new Error("The preparation session is invalid.");
  return {
    session: data.session,
    expiresAt: whole(data.expiresAt, 0, "Lease expiry"),
  };
}

export function validatePreparationJob(value: unknown): PreparationJob {
  const data = object(value, [
    "id",
    "source",
    "plan",
    "processor",
    "phase",
    "attempt",
    "outputPath",
    "keptOutputs",
    "lease",
    "output",
    "message",
    "updatedAt",
  ]);
  if (typeof data.id !== "string" || !hashPattern.test(data.id))
    throw new Error("The preparation job ID is invalid.");
  const input = source(data.source);
  const plan = validatePreparationPlan(data.plan);
  if (
    input.wav.frames !== plan.inputFrames ||
    input.wav.sampleRate !== plan.sampleRate ||
    input.wav.channels !== plan.channels ||
    (input.wav.loop !== undefined) !== plan.loop
  )
    throw new Error("The preparation plan does not match its source.");
  if (data.processor !== PREPARATION_PROCESSOR)
    throw new Error("The preparation processor is not supported.");
  const phases: readonly PreparationPhase[] = [
    "queued",
    "analysis",
    "conversion",
    "validation",
    "ready",
    "review",
    "failed",
    "cancelled",
  ];
  const phase = phases.find((item) => item === data.phase);
  if (!phase) throw new Error("The preparation phase is invalid.");
  const outputPath =
    data.outputPath === null ? null : validateSamplePath(data.outputPath);
  if (
    !Array.isArray(data.keptOutputs) ||
    data.keptOutputs.length > MAX_KEPT_OUTPUTS
  )
    throw new Error("The kept output list is invalid.");
  const keptOutputs = data.keptOutputs.map((path) => validateSamplePath(path));
  const keys = new Set(keptOutputs.map((path) => path.toLowerCase()));
  if (
    keys.size !== keptOutputs.length ||
    (outputPath !== null && keys.has(outputPath.toLowerCase()))
  )
    throw new Error("Output paths must be unique.");
  const held = lease(data.lease);
  if (ACTIVE_PHASES.includes(phase) !== (held !== null))
    throw new Error("Only an active preparation job has a session lease.");
  const result = data.output === null ? null : output(data.output);
  if (phase === "ready") {
    const measured = result?.analysis.measured;
    if (
      !result ||
      result.path !== outputPath ||
      result.analysis.status !== "ready" ||
      measured?.bpm !== plan.targetBpm ||
      measured.beatCount !== plan.beatCount ||
      result.wav.frames !== plan.outputFrames ||
      result.wav.sampleRate !== plan.sampleRate ||
      result.wav.channels !== plan.channels
    )
      throw new Error("A ready job needs a validated output file.");
  } else if (result) throw new Error("Only a ready job has an output file.");
  return {
    id: data.id,
    source: input,
    plan,
    processor: PREPARATION_PROCESSOR,
    phase,
    attempt: whole(data.attempt, 1, "Attempt number"),
    outputPath,
    keptOutputs,
    lease: held,
    output: result,
    message: message(data.message),
    updatedAt: whole(data.updatedAt, 0, "Update time"),
  };
}

export function emptyPreparationManifest(): PreparationManifest {
  return { schemaVersion: 1, revision: 0, jobs: {} };
}

export function validatePreparationManifest(
  value: unknown,
): PreparationManifest {
  const data = object(value, ["schemaVersion", "revision", "jobs"]);
  if (data.schemaVersion !== 1)
    throw new Error("The preparation manifest version is not supported.");
  const revision = whole(data.revision, 0, "Manifest revision");
  if (!data.jobs || typeof data.jobs !== "object" || Array.isArray(data.jobs))
    throw new Error("Preparation jobs must be an object.");
  const entries = Object.entries(data.jobs);
  if (entries.length > MAX_JOBS)
    throw new Error("The preparation manifest has too many jobs.");
  const jobs: PreparationManifest["jobs"] = {};
  const outputs = new Set<string>();
  for (const [id, row] of entries) {
    const job = validatePreparationJob(row);
    if (job.id !== id) throw new Error("A job key does not match its ID.");
    for (const path of [job.outputPath, ...job.keptOutputs]) {
      if (path === null) continue;
      if (outputs.has(path.toLowerCase()))
        throw new Error("Two jobs cannot use one output path.");
      outputs.add(path.toLowerCase());
    }
    jobs[id] = job;
  }
  return { schemaVersion: 1, revision, jobs };
}

export function parsePreparationManifest(text: string): PreparationManifest {
  if (
    new TextEncoder().encode(text).byteLength > MAX_PREPARATION_MANIFEST_BYTES
  )
    throw new Error("The preparation manifest is too large.");
  return validatePreparationManifest(JSON.parse(text));
}
