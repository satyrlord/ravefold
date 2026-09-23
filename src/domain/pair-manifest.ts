import type { AudioAnalysis } from "../audio/analyze.ts";
import type { StereoPairValidation } from "./stereo-pair.ts";
import { validateAudioRecord, validateWavInfo } from "./audio-manifest.ts";
import { validateSamplePath } from "./project.ts";
import type { WavInfo } from "./wav.ts";

export const PAIR_MANIFEST_FILENAME = "ravefold-pairs.manifest.json";
export const MAX_PAIR_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_PAIRS = 10_000;
const hashPattern = /^[0-9a-f]{64}$/u;
const userIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface PairSourceRef {
  path: string;
  sourceBytes: number;
  sourceSha256: string;
  wav: WavInfo;
}

export interface PairProvenance {
  kind: "user-selected";
  id: string;
}

export interface PairRecord {
  id: string;
  left: PairSourceRef;
  right: PairSourceRef;
  provenance: PairProvenance;
  alignment: Extract<StereoPairValidation, { valid: true }>;
  analysis: AudioAnalysis;
}

export interface PairManifest {
  schemaVersion: 1;
  revision: number;
  pairs: Record<string, PairRecord>;
}

function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Pair metadata must be an object.");
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== keys.length ||
    Object.keys(data).some((key) => !keys.includes(key))
  )
    throw new Error("Pair metadata has missing or unsupported fields.");
  return data;
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 240 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error(`${label} must be short readable text.`);
  return value;
}

function sourceRef(value: unknown): PairSourceRef {
  const data = object(value, ["path", "sourceBytes", "sourceSha256", "wav"]);
  const path = validateSamplePath(data.path);
  if (
    typeof data.sourceBytes !== "number" ||
    !Number.isSafeInteger(data.sourceBytes) ||
    data.sourceBytes < 44
  )
    throw new Error("The pair source byte count is invalid.");
  if (
    typeof data.sourceSha256 !== "string" ||
    !hashPattern.test(data.sourceSha256)
  )
    throw new Error("The pair source hash is invalid.");
  const wav = validateWavInfo(data.wav);
  if (wav.channels !== 1)
    throw new Error("A pair source must contain one audio channel.");
  const bytesPerFrame =
    wav.encoding === "pcm16" ? 2 : wav.encoding === "pcm24" ? 3 : 4;
  if (data.sourceBytes < 44 + wav.frames * bytesPerFrame)
    throw new Error("The pair source cannot contain its WAV frames.");
  return {
    path,
    sourceBytes: data.sourceBytes,
    sourceSha256: data.sourceSha256,
    wav,
  };
}

function sourceEvidence(value: unknown): { path: string; sha256: string } {
  const data = object(value, ["path", "sha256"]);
  const path = validateSamplePath(data.path);
  if (typeof data.sha256 !== "string" || !hashPattern.test(data.sha256))
    throw new Error("The pair evidence hash is invalid.");
  return { path, sha256: data.sha256 };
}

export function validatePairRecord(value: unknown): PairRecord {
  const data = object(value, [
    "id",
    "left",
    "right",
    "provenance",
    "alignment",
    "analysis",
  ]);
  if (typeof data.id !== "string" || !hashPattern.test(data.id))
    throw new Error("The pair ID is invalid.");
  const left = sourceRef(data.left);
  const right = sourceRef(data.right);
  if (left.path.toLowerCase() === right.path.toLowerCase())
    throw new Error("A pair needs two different source paths.");
  const origin = object(data.provenance, ["kind", "id"]);
  if (
    origin.kind !== "user-selected" ||
    typeof origin.id !== "string" ||
    !userIdPattern.test(origin.id)
  )
    throw new Error("The explicit pair selection ID is invalid.");
  const provenance: PairProvenance = { kind: origin.kind, id: origin.id };
  const measured = object(data.alignment, ["valid", "reason", "info"]);
  if (measured.valid !== true)
    throw new Error("The pair cannot claim unmeasured alignment.");
  const alignmentInfo = object(measured.info, [
    "encoding",
    "sampleRate",
    "frames",
    ...(left.wav.loop ? ["loop"] : []),
    "provenanceId",
    "left",
    "right",
  ]);
  const alignmentLeft = sourceEvidence(alignmentInfo.left);
  const alignmentRight = sourceEvidence(alignmentInfo.right);
  if (
    alignmentLeft.path !== left.path ||
    alignmentLeft.sha256 !== left.sourceSha256 ||
    alignmentRight.path !== right.path ||
    alignmentRight.sha256 !== right.sourceSha256 ||
    alignmentInfo.provenanceId !== provenance.id
  )
    throw new Error("Pair alignment evidence does not match its sources.");
  if (
    alignmentInfo.encoding !== left.wav.encoding ||
    alignmentInfo.encoding !== right.wav.encoding ||
    alignmentInfo.sampleRate !== left.wav.sampleRate ||
    alignmentInfo.sampleRate !== right.wav.sampleRate ||
    alignmentInfo.frames !== left.wav.frames ||
    alignmentInfo.frames !== right.wav.frames ||
    JSON.stringify(alignmentInfo.loop) !== JSON.stringify(left.wav.loop) ||
    JSON.stringify(alignmentInfo.loop) !== JSON.stringify(right.wav.loop)
  )
    throw new Error("Pair alignment measurements do not match its WAV files.");
  const analysis = validateAudioRecord({
    sourceSha256: left.sourceSha256,
    sourceBytes: left.sourceBytes,
    wav: left.wav,
    declared: null,
    measured: data.analysis,
    corrected: null,
  }).measured;
  return {
    id: data.id,
    left,
    right,
    provenance,
    alignment: {
      valid: true,
      reason: text(measured.reason, "Alignment reason"),
      info: {
        encoding: left.wav.encoding,
        sampleRate: left.wav.sampleRate,
        frames: left.wav.frames,
        ...(left.wav.loop ? { loop: left.wav.loop } : {}),
        provenanceId: provenance.id,
        left: alignmentLeft,
        right: alignmentRight,
      },
    },
    analysis,
  };
}

export function emptyPairManifest(): PairManifest {
  return { schemaVersion: 1, revision: 0, pairs: {} };
}

export function validatePairManifest(value: unknown): PairManifest {
  const data = object(value, ["schemaVersion", "revision", "pairs"]);
  if (data.schemaVersion !== 1)
    throw new Error("The pair manifest version is not supported.");
  if (
    typeof data.revision !== "number" ||
    !Number.isSafeInteger(data.revision) ||
    data.revision < 0
  )
    throw new Error("The pair manifest revision is invalid.");
  if (
    !data.pairs ||
    typeof data.pairs !== "object" ||
    Array.isArray(data.pairs)
  )
    throw new Error("Pair records must be an object.");
  const entries = Object.entries(data.pairs);
  if (entries.length > MAX_PAIRS)
    throw new Error("The pair manifest has too many records.");
  const pairs: PairManifest["pairs"] = {};
  for (const [id, value] of entries) {
    const row = validatePairRecord(value);
    if (id !== row.id) throw new Error("The pair key does not match its ID.");
    pairs[id] = row;
  }
  return { schemaVersion: 1, revision: data.revision, pairs };
}

export function parsePairManifest(source: string): PairManifest {
  if (new TextEncoder().encode(source).byteLength > MAX_PAIR_MANIFEST_BYTES)
    throw new Error("The pair manifest is too large.");
  return validatePairManifest(JSON.parse(source));
}

/** Hash ordered relative paths, including their separator, for a stable pair ID. */
export async function pairId(
  leftPath: string,
  rightPath: string,
): Promise<string> {
  const left = validateSamplePath(leftPath);
  const right = validateSamplePath(rightPath);
  if (left.toLowerCase() === right.toLowerCase())
    throw new Error("A pair needs two different source paths.");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${left}\u0000${right}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
