/// <reference path="./signalsmith-stretch.d.ts" />

interface StretchKernel {
  HEAP8: Int8Array;
  _presetDefault(channels: number, sampleRate: number): void;
  _setTransposeSemitones(semitones: number, tonalityLimit: number): void;
  _inputLatency(): number;
  _outputLatency(): number;
  _setBuffers(channels: number, length: number): number;
  _seek(inputSamples: number, playbackRate: number): void;
  _process(inputSamples: number, outputSamples: number): void;
}

type ProcessorClass = new (options: {
  numberOfOutputs: number;
  outputChannelCount: number[];
}) => { wasmModule: StretchKernel | null };

interface WorkletScope {
  AudioWorkletProcessor?: unknown;
  registerProcessor?: unknown;
  sampleRate?: unknown;
  currentTime?: unknown;
}

let processorClass: Promise<ProcessorClass> | undefined;
let readyListener: (() => void) | undefined;
let creation: Promise<unknown> = Promise.resolve();

function restore(scope: WorkletScope, key: keyof WorkletScope, value: unknown) {
  if (value === undefined) delete scope[key];
  else scope[key] = value;
}

/** The package registers its WASM kernel through AudioWorklet hooks. Capture it for offline use. */
function loadProcessor(): Promise<ProcessorClass> {
  processorClass ??= (async () => {
    const scope = globalThis as WorkletScope;
    const previousProcessor = scope.AudioWorkletProcessor;
    const previousRegister = scope.registerProcessor;
    let captured: ProcessorClass | undefined;
    scope.AudioWorkletProcessor = class {
      port = {
        onmessage: null,
        postMessage: (message: unknown) => {
          if (Array.isArray(message) && message[0] === "ready")
            readyListener?.();
        },
      };
    };
    scope.registerProcessor = (_name: string, value: ProcessorClass) => {
      captured = value;
    };
    try {
      await import("signalsmith-stretch");
    } finally {
      restore(scope, "AudioWorkletProcessor", previousProcessor);
      restore(scope, "registerProcessor", previousRegister);
    }
    if (!captured) throw new Error("The time-stretch kernel is unavailable.");
    return captured;
  })().catch((error: unknown) => {
    processorClass = undefined;
    throw error;
  });
  return processorClass;
}

/** Make one kernel at a time. Its setup reads the worklet sample-rate global. */
async function createKernel(
  channels: number,
  sampleRate: number,
): Promise<StretchKernel> {
  const Processor = await loadProcessor();
  const task = creation.then(async () => {
    const scope = globalThis as WorkletScope;
    const previousRate = scope.sampleRate;
    const previousTime = scope.currentTime;
    scope.sampleRate = sampleRate;
    scope.currentTime = 0;
    try {
      let processor: InstanceType<ProcessorClass> | undefined;
      await new Promise<void>((resolve) => {
        readyListener = resolve;
        processor = new Processor({
          numberOfOutputs: 1,
          outputChannelCount: [channels],
        });
      });
      const kernel = processor?.wasmModule;
      if (!kernel) throw new Error("The time-stretch kernel did not start.");
      return kernel;
    } finally {
      readyListener = undefined;
      restore(scope, "sampleRate", previousRate);
      restore(scope, "currentTime", previousTime);
    }
  });
  creation = task.catch(() => undefined);
  return task;
}

export interface StretchInput {
  channels: readonly Float32Array[];
  sampleRate: number;
  outputFrames: number;
  semitones: number;
  /** Read a loop as a continuous signal at both boundaries. */
  circular: boolean;
}

export interface StretchResult {
  channels: Float32Array[];
  latencyFrames: number;
  stretchedFrames: number;
}

export interface StretchControl {
  /** Report progress. Reject to stop, or wait to give other work priority. */
  checkpoint?(fraction: number): Promise<void>;
}

const BLOCK_FRAMES = 1024;
const RESAMPLE_HALF_TAPS = 32;
const RESAMPLE_PHASES = 256;

function sampleAt(
  channel: Float32Array,
  index: number,
  circular: boolean,
): number {
  const frames = channel.length;
  if (circular) return channel[((index % frames) + frames) % frames]!;
  return index >= 0 && index < frames ? channel[index]! : 0;
}

/** Build normalized Blackman-windowed sinc weights for each fractional phase. */
function resampleTable(cutoff: number): Float32Array {
  const taps = RESAMPLE_HALF_TAPS * 2;
  const table = new Float32Array((RESAMPLE_PHASES + 1) * taps);
  for (let phase = 0; phase <= RESAMPLE_PHASES; phase++) {
    const fraction = phase / RESAMPLE_PHASES;
    let sum = 0;
    for (let tap = 0; tap < taps; tap++) {
      const distance = tap - RESAMPLE_HALF_TAPS + 1 - fraction;
      const x = Math.PI * cutoff * distance;
      const sinc = x === 0 ? 1 : Math.sin(x) / x;
      const window =
        Math.abs(distance) >= RESAMPLE_HALF_TAPS
          ? 0
          : 0.42 +
            0.5 * Math.cos((Math.PI * distance) / RESAMPLE_HALF_TAPS) +
            0.08 * Math.cos((2 * Math.PI * distance) / RESAMPLE_HALF_TAPS);
      const weight = cutoff * sinc * window;
      table[phase * taps + tap] = weight;
      sum += weight;
    }
    for (let tap = 0; tap < taps; tap++) table[phase * taps + tap]! /= sum;
  }
  return table;
}

/** Change pitch by an exact rate ratio. The caller has already set the duration. */
async function resample(
  source: Float32Array,
  frames: number,
  circular: boolean,
  checkpoint: (fraction: number) => Promise<void>,
): Promise<Float32Array> {
  const step = source.length / frames;
  const table = resampleTable(Math.min(1, 1 / step));
  const taps = RESAMPLE_HALF_TAPS * 2;
  const output = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const position = frame * step;
    const base = Math.floor(position);
    const phase = (position - base) * RESAMPLE_PHASES;
    const row = Math.floor(phase);
    const blend = phase - row;
    const lower = row * taps;
    const upper = Math.min(row + 1, RESAMPLE_PHASES) * taps;
    let value = 0;
    for (let tap = 0; tap < taps; tap++) {
      const weight =
        table[lower + tap]! +
        (table[upper + tap]! - table[lower + tap]!) * blend;
      value +=
        weight *
        sampleAt(source, base + tap - RESAMPLE_HALF_TAPS + 1, circular);
    }
    output[frame] = value;
    if (frame % 65_536 === 65_535) await checkpoint(frame / frames);
  }
  return output;
}

/**
 * Change duration with the stretch kernel at unchanged pitch. Then resample
 * for pitch, because a rate ratio gives an exact pitch ratio.
 */
export async function stretchAudio(
  input: StretchInput,
  control: StretchControl = {},
): Promise<StretchResult> {
  const count = input.channels.length;
  const frames = input.channels[0]?.length ?? 0;
  if (
    (count !== 1 && count !== 2) ||
    frames === 0 ||
    input.channels.some((channel) => channel.length !== frames) ||
    !Number.isSafeInteger(input.outputFrames) ||
    input.outputFrames <= 0 ||
    !Number.isInteger(input.semitones) ||
    Math.abs(input.semitones) > 6
  )
    throw new Error("The conversion request is invalid.");
  const checkpoint = control.checkpoint ?? (async () => undefined);
  const stretchedFrames = input.semitones
    ? Math.round(input.outputFrames * 2 ** (input.semitones / 12))
    : input.outputFrames;
  const ratio = stretchedFrames / frames;
  if (!(ratio >= 0.2 && ratio <= 5))
    throw new Error("The conversion ratio is outside the supported range.");
  const kernel = await createKernel(count, input.sampleRate);
  kernel._presetDefault(count, input.sampleRate);
  kernel._setTransposeSemitones(0, 8000 / input.sampleRate);
  const inputLatency = kernel._inputLatency();
  const outputLatency = kernel._outputLatency();
  const capacity = Math.max(
    BLOCK_FRAMES,
    inputLatency + outputLatency,
    Math.ceil(BLOCK_FRAMES / ratio) + 2,
  );
  const pointer = kernel._setBuffers(count, capacity);
  // Memory can grow, so read the heap views again after each kernel call.
  const buffer = (index: number) =>
    new Float32Array(
      kernel.HEAP8.buffer,
      pointer + capacity * 4 * index,
      capacity,
    );
  const fill = (start: number, length: number) => {
    for (let channel = 0; channel < count; channel++) {
      const target = buffer(channel);
      const source = input.channels[channel]!;
      for (let index = 0; index < length; index++)
        target[index] = sampleAt(source, start + index, input.circular);
    }
  };
  // The history ends one input latency after the first frame.
  fill(-outputLatency, inputLatency + outputLatency);
  kernel._seek(inputLatency + outputLatency, 1 / ratio);
  const stretched = input.channels.map(() => new Float32Array(stretchedFrames));
  const total = stretchedFrames + outputLatency;
  const share = input.semitones ? 0.75 : 1;
  let produced = 0;
  let fed = inputLatency;
  let blocks = 0;
  while (produced < total) {
    const length = Math.min(BLOCK_FRAMES, total - produced);
    const next = inputLatency + Math.round((produced + length) / ratio);
    fill(fed, next - fed);
    kernel._process(next - fed, length);
    for (let channel = 0; channel < count; channel++) {
      const output = buffer(count + channel);
      const target = stretched[channel]!;
      for (let index = 0; index < length; index++) {
        const frame = produced + index - outputLatency;
        if (frame >= 0 && frame < stretchedFrames)
          target[frame] = output[index]!;
      }
    }
    fed = next;
    produced += length;
    if (++blocks % 32 === 0) await checkpoint((produced / total) * share);
  }
  await checkpoint(share);
  if (!input.semitones)
    return {
      channels: stretched,
      latencyFrames: outputLatency,
      stretchedFrames,
    };
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < count; channel++)
    channels.push(
      await resample(
        stretched[channel]!,
        input.outputFrames,
        input.circular,
        (fraction) =>
          checkpoint(share + ((channel + fraction) / count) * (1 - share)),
      ),
    );
  await checkpoint(1);
  return { channels, latencyFrames: outputLatency, stretchedFrames };
}
