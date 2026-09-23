export interface WavInfo {
  encoding: "pcm16" | "pcm24" | "float32";
  channels: 1 | 2;
  sampleRate: number;
  frames: number;
  duration: number;
  loop?: { startFrame: number; endFrameExclusive: number };
}

export type WavValidation =
  { valid: true; info: WavInfo } | { valid: false; reason: string };

function tag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

async function viewAt(
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

/** Validate container structure and complete frames without audio decoding. */
export async function validateWav(
  file: Blob,
  signal?: AbortSignal,
): Promise<WavValidation> {
  const invalid = (reason: string): WavValidation => ({ valid: false, reason });
  signal?.throwIfAborted();
  if (file.size < 44) return invalid("The WAV header is incomplete.");
  const header = await viewAt(file, 0, 12, signal);
  if (tag(header, 0) !== "RIFF" || tag(header, 8) !== "WAVE") {
    return invalid("The file is not a supported WAV container.");
  }
  const end = header.getUint32(4, true) + 8;
  if (end > file.size || end < 44)
    return invalid("The WAV data is incomplete.");
  if (end !== file.size)
    return invalid("The WAV container size does not match the file.");
  let format: DataView | undefined;
  let formatSize = 0;
  let dataOffset = 0;
  let dataSize = 0;
  let sawData = false;
  let sawSampler = false;
  let loop: WavInfo["loop"];
  let offset = 12;
  while (offset < end) {
    if (offset + 8 > end) return invalid("A WAV chunk header is incomplete.");
    const chunk = await viewAt(file, offset, 8, signal);
    const size = chunk.getUint32(4, true);
    const next = offset + 8 + size + (size % 2);
    if (next > end) return invalid("A WAV chunk is incomplete.");
    const kind = tag(chunk, 0);
    if (kind === "fmt ") {
      if (format || size < 16) return invalid("The WAV format is invalid.");
      format = await viewAt(file, offset + 8, Math.min(size, 40), signal);
      formatSize = size;
    }
    if (kind === "data") {
      if (sawData)
        return invalid("Multiple WAV data chunks are not supported.");
      sawData = true;
      dataOffset = offset + 8;
      dataSize = size;
    }
    if (kind === "smpl") {
      if (sawSampler)
        return invalid("Multiple WAV sampler chunks are not supported.");
      sawSampler = true;
      if (size < 36) return invalid("The WAV loop marker is incomplete.");
      const marker = await viewAt(file, offset + 8, Math.min(size, 60), signal);
      const count = marker.getUint32(28, true);
      const samplerBytes = marker.getUint32(32, true);
      if (count > 1)
        return invalid("Multiple WAV loop markers are not supported.");
      if (size !== 36 + count * 24 + samplerBytes)
        return invalid("The WAV loop marker size is invalid.");
      if (count === 1) {
        if (
          marker.getUint32(40, true) !== 0 ||
          marker.getUint32(52, true) !== 0
        )
          return invalid("The WAV loop marker type is not supported.");
        const startFrame = marker.getUint32(44, true);
        const endFrame = marker.getUint32(48, true);
        if (startFrame > endFrame)
          return invalid("The WAV loop marker has invalid boundaries.");
        // RIFF smpl stores the final frame as an inclusive index.
        loop = { startFrame, endFrameExclusive: endFrame + 1 };
      }
    }
    offset = next;
  }
  if (!format || !sawData || dataSize === 0) {
    return invalid("The WAV file has no usable audio data.");
  }
  let code = format.getUint16(0, true);
  const channels = format.getUint16(2, true);
  const sampleRate = format.getUint32(4, true);
  const byteRate = format.getUint32(8, true);
  const alignment = format.getUint16(12, true);
  const bits = format.getUint16(14, true);
  if (code === 0xfffe) {
    if (
      format.byteLength < 40 ||
      format.getUint16(16, true) < 22 ||
      format.getUint16(16, true) + 18 > formatSize ||
      format.getUint16(18, true) !== bits ||
      format.getUint16(26, true) !== 0 ||
      format.getUint32(28, true) !== 0x00100000 ||
      format.getUint32(32, false) !== 0x800000aa ||
      format.getUint32(36, false) !== 0x00389b71
    ) {
      return invalid("The extended WAV format is not supported.");
    }
    code = format.getUint16(24, true);
  }
  if (
    !(
      (code === 1 && (bits === 16 || bits === 24)) ||
      (code === 3 && bits === 32)
    ) ||
    (channels !== 1 && channels !== 2)
  ) {
    return invalid("Use mono or stereo WAV PCM16, PCM24 or float32.");
  }
  if (
    sampleRate === 0 ||
    alignment !== (channels * bits) / 8 ||
    byteRate !== sampleRate * alignment ||
    dataSize % alignment !== 0
  ) {
    return invalid("The WAV frame data is invalid.");
  }
  if (code === 3) {
    const blockSize = 262144;
    for (
      let start = dataOffset;
      start < dataOffset + dataSize;
      start += blockSize
    ) {
      const data = await viewAt(
        file,
        start,
        Math.min(blockSize, dataOffset + dataSize - start),
        signal,
      );
      for (let i = 0; i < data.byteLength; i += 4) {
        if (!Number.isFinite(data.getFloat32(i, true))) {
          return invalid("The WAV file contains invalid floating-point audio.");
        }
      }
    }
  }
  signal?.throwIfAborted();
  const frames = dataSize / alignment;
  if (loop && loop.endFrameExclusive > frames)
    return invalid("The WAV loop marker is outside the audio.");
  return {
    valid: true,
    info: {
      encoding: code === 3 ? "float32" : bits === 16 ? "pcm16" : "pcm24",
      channels,
      sampleRate,
      frames,
      duration: frames / sampleRate,
      ...(loop ? { loop } : {}),
    },
  };
}
