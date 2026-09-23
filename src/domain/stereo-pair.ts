import { decodeWav, type DecodedWav } from "../audio/pcm.ts";
import { validateSamplePath } from "./project.ts";
import { validateWav, type WavInfo } from "./wav.ts";

export interface StereoPairSource {
  path: string;
  file: Blob;
}

export interface StereoPairSourceEvidence {
  path: string;
  sha256: string;
}

/** An explicit record of source identity and channel order. */
export interface StereoPairEvidence {
  provenanceId: string;
  channelOrder: "left-right" | "right-left";
  frameOffset: number;
  left: StereoPairSourceEvidence;
  right: StereoPairSourceEvidence;
}

export interface StereoPairInfo {
  encoding: WavInfo["encoding"];
  sampleRate: number;
  frames: number;
  loop?: NonNullable<WavInfo["loop"]>;
  provenanceId: string;
  left: StereoPairSourceEvidence;
  right: StereoPairSourceEvidence;
}

export type StereoPairValidation =
  | { valid: true; reason: string; info: StereoPairInfo }
  | { valid: false; reason: string };

async function sha256(file: Blob, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const bytes = await file.arrayBuffer();
  signal?.throwIfAborted();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  signal?.throwIfAborted();
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Measure strong attacks in one-millisecond RMS blocks. */
function onsets(decoded: DecodedWav, signal?: AbortSignal): number[] | null {
  const audio = decoded.channels[0];
  if (!audio) return null;
  const blockFrames = Math.max(1, Math.round(decoded.sampleRate / 1000));
  const count = Math.ceil(decoded.frames / blockFrames);
  const envelope = new Float32Array(count);
  let peak = 0;
  for (let block = 0; block < count; block++) {
    if (block % 4096 === 0) signal?.throwIfAborted();
    const start = block * blockFrames;
    const end = Math.min(decoded.frames, start + blockFrames);
    let power = 0;
    for (let frame = start; frame < end; frame++)
      power += audio[frame]! * audio[frame]!;
    const level = Math.sqrt(power / (end - start));
    envelope[block] = level;
    peak = Math.max(peak, level);
  }
  if (peak < 0.01) return null;
  const found: number[] = [];
  const minGap = Math.ceil((0.06 * decoded.sampleRate) / blockFrames);
  for (let block = 0; block < count; block++) {
    const previous = block ? envelope[block - 1]! : 0;
    if (
      envelope[block]! >= peak * 0.2 &&
      envelope[block]! - previous >= peak * 0.15 &&
      (!found.length ||
        block * blockFrames - found.at(-1)! >= minGap * blockFrames)
    )
      found.push(block * blockFrames);
    if (found.length > 256) return null;
  }
  return found.length >= 3 ? found : null;
}

/** Check supplied evidence and file structure. The caller must verify provenance. */
export async function validateStereoPair(
  left: StereoPairSource,
  right: StereoPairSource,
  evidence: StereoPairEvidence | null | undefined,
  signal?: AbortSignal,
): Promise<StereoPairValidation> {
  const fail = (reason: string): StereoPairValidation => ({
    valid: false,
    reason,
  });
  signal?.throwIfAborted();
  try {
    validateSamplePath(left.path);
    validateSamplePath(right.path);
  } catch {
    return fail("Both sources need valid relative WAV paths.");
  }
  if (left.path.toLowerCase() === right.path.toLowerCase())
    return fail("The left and right sources must have different paths.");
  if (!evidence || !evidence.left || !evidence.right)
    return fail("Explicit source-pair evidence is required.");
  if (
    typeof evidence.provenanceId !== "string" ||
    !evidence.provenanceId.trim()
  )
    return fail("The source-pair provenance ID is required.");
  if (evidence.channelOrder !== "left-right")
    return fail("The evidence must declare left then right channel order.");
  if (evidence.frameOffset !== 0)
    return fail("The evidence must declare zero frame offset.");
  if (evidence.left.path !== left.path || evidence.right.path !== right.path)
    return fail("The source paths do not match the declared channel order.");
  const hashPattern = /^[0-9a-f]{64}$/iu;
  if (
    !hashPattern.test(evidence.left.sha256) ||
    !hashPattern.test(evidence.right.sha256)
  )
    return fail("Each source needs a valid SHA-256 value.");
  const leftWav = await validateWav(left.file, signal);
  if (!leftWav.valid) return fail(`The left WAV is invalid: ${leftWav.reason}`);
  const rightWav = await validateWav(right.file, signal);
  if (!rightWav.valid)
    return fail(`The right WAV is invalid: ${rightWav.reason}`);
  const a = leftWav.info;
  const b = rightWav.info;
  if (a.channels !== 1 || b.channels !== 1)
    return fail("A split stereo pair needs two mono WAV files.");
  if (a.encoding !== b.encoding)
    return fail("The source encodings do not match.");
  if (a.sampleRate !== b.sampleRate)
    return fail("The source sample rates do not match.");
  if (a.sampleRate < 1000)
    return fail(
      "The source sample rate cannot establish millisecond alignment.",
    );
  if (a.frames !== b.frames)
    return fail("The source frame counts do not match.");
  if (
    Boolean(a.loop) !== Boolean(b.loop) ||
    (a.loop &&
      b.loop &&
      (a.loop.startFrame !== b.loop.startFrame ||
        a.loop.endFrameExclusive !== b.loop.endFrameExclusive))
  )
    return fail("The source loop boundaries do not match.");
  if (!globalThis.crypto?.subtle)
    return fail("SHA-256 is unavailable in this browser.");
  try {
    const leftHash = await sha256(left.file, signal);
    if (leftHash !== evidence.left.sha256.toLowerCase())
      return fail("The left source does not match its SHA-256 evidence.");
    const rightHash = await sha256(right.file, signal);
    if (rightHash !== evidence.right.sha256.toLowerCase())
      return fail("The right source does not match its SHA-256 evidence.");
  } catch (error) {
    if (signal?.aborted) throw error;
    return fail("The source hashes could not be checked.");
  }
  let leftOnsets: number[] | null;
  let rightOnsets: number[] | null;
  try {
    leftOnsets = onsets(await decodeWav(left.file, signal), signal);
    rightOnsets = onsets(await decodeWav(right.file, signal), signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return fail("The source audio could not be checked for channel alignment.");
  }
  if (!leftOnsets || !rightOnsets)
    return fail(
      "The channel audio has too few clear onsets to confirm alignment.",
    );
  if (
    leftOnsets.length !== rightOnsets.length ||
    leftOnsets.some((frame, index) => frame !== rightOnsets![index]!)
  )
    return fail("The channel onsets do not align at the declared zero offset.");
  return {
    valid: true,
    reason:
      "Source evidence and channel attacks align in the same 1 ms blocks. Phase and audible quality need a listening check.",
    info: {
      encoding: a.encoding,
      sampleRate: a.sampleRate,
      frames: a.frames,
      ...(a.loop ? { loop: a.loop } : {}),
      provenanceId: evidence.provenanceId,
      left: { path: left.path, sha256: evidence.left.sha256.toLowerCase() },
      right: { path: right.path, sha256: evidence.right.sha256.toLowerCase() },
    },
  };
}
