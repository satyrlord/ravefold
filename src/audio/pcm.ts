import { validateWav, type WavInfo } from "../domain/wav.ts";

export const MAX_DECODE_WAV_BYTES = 100 * 1024 * 1024;
export const MAX_DECODE_WAV_SECONDS = 5 * 60;

export interface DecodedWav {
  sampleRate: number;
  frames: number;
  channels: Float32Array[];
  loop?: { startFrame: number; endFrameExclusive: number };
  encoding: WavInfo["encoding"];
}

async function readAt(
  file: Blob,
  start: number,
  size: number,
  signal?: AbortSignal,
): Promise<DataView> {
  signal?.throwIfAborted();
  const bytes = await file.slice(start, start + size).arrayBuffer();
  signal?.throwIfAborted();
  if (bytes.byteLength !== size) throw new Error("The WAV file is incomplete.");
  return new DataView(bytes);
}

async function dataStart(file: Blob, signal?: AbortSignal): Promise<number> {
  let offset = 12;
  while (offset + 8 <= file.size) {
    const chunk = await readAt(file, offset, 8, signal);
    const kind = String.fromCharCode(
      chunk.getUint8(0),
      chunk.getUint8(1),
      chunk.getUint8(2),
      chunk.getUint8(3),
    );
    if (kind === "data") return offset + 8;
    const size = chunk.getUint32(4, true);
    offset += 8 + size + (size % 2);
  }
  throw new Error("The WAV file has no audio data.");
}

function pcm24(view: DataView, offset: number): number {
  const value =
    view.getUint8(offset) |
    (view.getUint8(offset + 1) << 8) |
    (view.getUint8(offset + 2) << 16);
  return ((value << 8) >> 8) / 8388608;
}

/** Decode validated WAV frames without Web Audio or a full-file byte buffer. */
export async function decodeWav(
  file: Blob,
  signal?: AbortSignal,
): Promise<DecodedWav> {
  signal?.throwIfAborted();
  if (file.size > MAX_DECODE_WAV_BYTES)
    throw new Error("WAV decoding supports files up to 100 MiB.");
  const validation = await validateWav(file, signal);
  if (!validation.valid) throw new Error(validation.reason);
  const info = validation.info;
  if (info.duration > MAX_DECODE_WAV_SECONDS)
    throw new Error("WAV decoding supports up to five minutes.");

  const start = await dataStart(file, signal);
  const sampleBytes =
    info.encoding === "pcm16" ? 2 : info.encoding === "pcm24" ? 3 : 4;
  const frameBytes = sampleBytes * info.channels;
  const framesPerBlock = Math.floor(262144 / frameBytes);
  const channels: Float32Array[] = Array.from(
    { length: info.channels },
    () => new Float32Array(info.frames),
  );

  let blocks = 0;
  for (
    let firstFrame = 0;
    firstFrame < info.frames;
    firstFrame += framesPerBlock
  ) {
    const count = Math.min(framesPerBlock, info.frames - firstFrame);
    const block = await readAt(
      file,
      start + firstFrame * frameBytes,
      count * frameBytes,
      signal,
    );
    let position = 0;
    for (let frame = 0; frame < count; frame++) {
      if (frame % 8192 === 0) signal?.throwIfAborted();
      for (let channel = 0; channel < channels.length; channel++) {
        let value: number;
        if (info.encoding === "pcm16")
          value = block.getInt16(position, true) / 32768;
        else if (info.encoding === "pcm24") value = pcm24(block, position);
        else value = block.getFloat32(position, true);
        if (!Number.isFinite(value))
          throw new Error(
            "The WAV file contains invalid floating-point audio.",
          );
        channels[channel][firstFrame + frame] = value;
        position += sampleBytes;
      }
    }
    if (++blocks % 16 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
  }
  signal?.throwIfAborted();
  return {
    sampleRate: info.sampleRate,
    frames: info.frames,
    channels,
    encoding: info.encoding,
    ...(info.loop ? { loop: info.loop } : {}),
  };
}
