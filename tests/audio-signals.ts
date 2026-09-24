import { encodeFloatWav } from "../src/audio/wav-encode.ts";

export const RATE = 48_000;
export const NATURAL = [60, 63, 67, 68, 70, 67, 63, 60];

/** Generated notes with one note on each beat. */
export function phrase(
  bpm: number,
  notes: readonly number[],
  options: { tuned?: boolean; sampleRate?: number } = {},
): Float32Array {
  const sampleRate = options.sampleRate ?? RATE;
  const beatFrames = (sampleRate * 60) / bpm;
  const audio = new Float32Array(Math.round(notes.length * beatFrames));
  for (let beat = 0; beat < notes.length; beat++) {
    const start = Math.round(beat * beatFrames);
    const end = Math.round((beat + 1) * beatFrames);
    const active = Math.floor((end - start) * 0.82);
    const frequency = 440 * 2 ** ((notes[beat]! - 69) / 12);
    const accent = bpm === 180 && beat % 4 === 0 ? 1.6 : 1;
    for (let frame = 0; frame < active; frame++) {
      const seconds = frame / sampleRate;
      const envelope = options.tuned
        ? Math.exp((-7 * frame) / (end - start))
        : 1;
      audio[start + frame] =
        0.45 *
        accent *
        Math.min(1, seconds / 0.006) *
        envelope *
        Math.sin(2 * Math.PI * frequency * seconds);
    }
  }
  return audio;
}

/** Generated noise hits, one at each start time in seconds. */
export function noise(
  seconds: number,
  pulses: readonly number[],
): Float32Array {
  const audio = new Float32Array(Math.round(seconds * RATE));
  let seed = 0x5a17;
  for (const pulse of pulses) {
    const start = Math.round(pulse * RATE);
    const active = Math.min(Math.round(RATE * 0.25), audio.length - start);
    for (let frame = 0; frame < active; frame++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const random = (seed >>> 0) / 0xffffffff;
      audio[start + frame] =
        (random * 2 - 1) * Math.exp((-10 * frame) / active) * 0.8;
    }
  }
  return audio;
}

/** Key-neutral hits with one attack on each beat. */
export function drumLoop(bpm: number, beats: number): Float32Array {
  const beat = 60 / bpm;
  return noise(
    beat * beats,
    Array.from({ length: beats }, (_, index) => index * beat),
  );
}

export function tone(frequency: number, frames: number): Float32Array {
  const audio = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++)
    audio[frame] = 0.5 * Math.sin((2 * Math.PI * frequency * frame) / RATE);
  return audio;
}

/** Measure a sustained tone from interpolated upward zero crossings. */
export function measuredFrequency(audio: Float32Array): number {
  let crossings = 0;
  let first = -1;
  let last = -1;
  for (let index = 1; index < audio.length; index++) {
    const before = audio[index - 1]!;
    const after = audio[index]!;
    if (before < 0 && after >= 0) {
      const position = index - 1 - before / (after - before);
      if (first < 0) first = position;
      last = position;
      crossings++;
    }
  }
  return ((crossings - 1) * RATE) / (last - first);
}

export function cents(measured: number, expected: number): number {
  return 1200 * Math.log2(measured / expected);
}

export function wavFile(
  channels: Float32Array | readonly Float32Array[],
  loop = false,
): Uint8Array<ArrayBuffer> {
  const list = channels instanceof Float32Array ? [channels] : channels;
  return new Uint8Array(encodeFloatWav(list, RATE, loop));
}
