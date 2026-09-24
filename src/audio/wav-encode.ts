/** Encode float32 WAV bytes. A loop marker covers all frames. */
export function encodeFloatWav(
  channels: readonly Float32Array[],
  sampleRate: number,
  loop: boolean,
): ArrayBuffer {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  if (
    (count !== 1 && count !== 2) ||
    frames === 0 ||
    channels.some((channel) => channel.length !== frames) ||
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0
  )
    throw new Error("The output audio cannot be encoded.");
  const dataBytes = frames * count * 4;
  const samplerBytes = loop ? 8 + 60 : 0;
  const total = 12 + 8 + 16 + samplerBytes + 8 + dataBytes;
  const bytes = new ArrayBuffer(total);
  const view = new DataView(bytes);
  const tag = (offset: number, value: string) => {
    for (let index = 0; index < 4; index++)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  tag(0, "RIFF");
  view.setUint32(4, total - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 4, true);
  view.setUint16(32, count * 4, true);
  view.setUint16(34, 32, true);
  let offset = 36;
  if (loop) {
    tag(offset, "smpl");
    view.setUint32(offset + 4, 60, true);
    // One forward loop. RIFF smpl stores the final frame as an inclusive index.
    view.setUint32(offset + 8 + 28, 1, true);
    view.setUint32(offset + 8 + 44, 0, true);
    view.setUint32(offset + 8 + 48, frames - 1, true);
    offset += 68;
  }
  tag(offset, "data");
  view.setUint32(offset + 4, dataBytes, true);
  offset += 8;
  for (let frame = 0; frame < frames; frame++)
    for (let channel = 0; channel < count; channel++) {
      view.setFloat32(offset, channels[channel]![frame]!, true);
      offset += 4;
    }
  return bytes;
}
