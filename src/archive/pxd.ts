const SAMPLE_RATE = 44_100;
const MAX_DECODED_SAMPLES = 64 * 1024 * 1024;
const MAX_EXPANSION = 8;

// The PXD delta table maps each audio code to a signed 16-bit change.
// prettier-ignore
const DPCM_STEPS = [
  0,
  -25266, -24412, -23582, -22776, -21992, -21232, -20494, -19778,
  -19082, -18406, -17752, -17116, -16500, -15904, -15326, -14766,
  -14222, -13696, -13186, -12692, -12214, -11752, -11304, -10872,
  -10454, -10050, -9660, -9282, -8916, -8564, -8224, -7896,
  -7578, -7272, -6976, -6690, -6414, -6148, -5892, -5646,
  -5408, -5178, -4958, -4746, -4542, -4346, -4156, -3974,
  -3798, -3630, -3468, -3312, -3162, -3018, -2880, -2748,
  -2620, -2498, -2380, -2268, -2160, -2056, -1956, -1860,
  -1768, -1680, -1596, -1516, -1440, -1366, -1296, -1228,
  -1164, -1102, -1044, -988, -934, -882, -834, -788,
  -744, -702, -662, -624, -588, -554, -520, -488,
  -458, -430, -402, -376, -352, -328, -306, -286,
  -266, -248, -230, -214, -198, -182, -168, -154,
  -142, -130, -118, -108, -98, -88, -80, -72,
  -64, -56, -50, -44, -38, -32, -26, -22,
  -18, -14, -10, -8, -6, -4, -2, 0,
  2, 4, 6, 8, 10, 14, 18, 22,
  26, 32, 38, 44, 50, 56, 64, 72,
  80, 88, 98, 108, 118, 130, 142, 154,
  168, 182, 198, 214, 230, 248, 266, 286,
  306, 328, 352, 376, 402, 430, 458, 488,
  520, 554, 588, 624, 662, 702, 744, 788,
  834, 882, 934, 988, 1044, 1102, 1164, 1228,
  1296, 1366, 1440, 1516, 1596, 1680, 1768, 1860,
  1956, 2056, 2160, 2268, 2380, 2498, 2620, 2748,
  2880, 3018, 3162, 3312, 3468, 3630, 3798, 3974,
  4156, 4346, 4542, 4746, 4958, 5178, 5408, 5646,
  5892, 6148, 6414, 6690, 6976, 7272, 7578, 7896,
  8224, 8564, 8916, 9282, 9660, 10050, 10454, 10872,
  11304, 11752, 12214, 12692, 13186, 13696, 14222, 14766,
  15326, 15904, 16500,
] as const;

function matches(
  bytes: Uint8Array<ArrayBuffer>,
  offset: number,
  text: string,
): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function writeText(
  bytes: Uint8Array<ArrayBuffer>,
  offset: number,
  text: string,
): void {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
}

function copySupportedWav(
  input: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  if (input.length < 44 || !matches(input, 8, "WAVE")) {
    throw new Error("The WAV header is invalid.");
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const end = view.getUint32(4, true) + 8;
  if (end !== input.length) throw new Error("The WAV size is invalid.");

  let formatFound = false;
  let dataFound = false;
  let offset = 12;
  while (offset < end) {
    if (offset + 8 > end) throw new Error("A WAV chunk header is incomplete.");
    const size = view.getUint32(offset + 4, true);
    const next = offset + 8 + size + (size % 2);
    if (next > end) throw new Error("A WAV chunk is incomplete.");
    if (matches(input, offset, "fmt ")) {
      if (formatFound || size < 16)
        throw new Error("The WAV format is invalid.");
      formatFound = true;
      const start = offset + 8;
      if (
        view.getUint16(start, true) !== 1 ||
        view.getUint16(start + 2, true) !== 1 ||
        view.getUint32(start + 4, true) !== SAMPLE_RATE ||
        view.getUint32(start + 8, true) !== SAMPLE_RATE * 2 ||
        view.getUint16(start + 12, true) !== 2 ||
        view.getUint16(start + 14, true) !== 16
      ) {
        throw new Error("The WAV audio format is not supported.");
      }
    }
    if (matches(input, offset, "data")) {
      if (
        dataFound ||
        size === 0 ||
        size % 2 !== 0 ||
        size / 2 > MAX_DECODED_SAMPLES
      ) {
        throw new Error("The WAV audio size is invalid.");
      }
      dataFound = true;
    }
    offset = next;
  }
  if (!formatFound || !dataFound)
    throw new Error("The WAV audio data is missing.");
  return input.slice();
}

/** Convert one PXD or supported RIFF file to mono, 16-bit PCM WAV at 44.1 kHz. */
export function decodePxdToWav(
  input: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  if (input.length >= 4 && matches(input, 0, "RIFF")) {
    return copySupportedWav(input);
  }
  let markerOffset: number;
  if (input.length >= 12 && matches(input, 0, "tPxD")) {
    markerOffset = 5 + input[4];
  } else if (
    input.length >= 8 &&
    input[0] === 0x54 &&
    input[5] === 0 &&
    input[6] === 0
  ) {
    markerOffset = 0;
  } else {
    throw new Error("The PXD header is invalid.");
  }

  if (markerOffset + 7 > input.length || input[markerOffset] !== 0x54) {
    throw new Error("The PXD audio header is invalid.");
  }

  const source = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const decodedSize = source.getUint32(markerOffset + 1, true);
  const audioOffset = markerOffset + 7;
  const compressedSize = input.length - audioOffset;
  if (
    decodedSize === 0 ||
    decodedSize > MAX_DECODED_SAMPLES ||
    compressedSize === 0 ||
    decodedSize > compressedSize * MAX_EXPANSION + 1
  ) {
    throw new Error("The PXD audio size is invalid.");
  }

  const output = new Uint8Array(44 + decodedSize * 2);
  const wav = new DataView(output.buffer);
  writeText(output, 0, "RIFF");
  wav.setUint32(4, output.length - 8, true);
  writeText(output, 8, "WAVEfmt ");
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 1, true);
  wav.setUint32(24, SAMPLE_RATE, true);
  wav.setUint32(28, SAMPLE_RATE * 2, true);
  wav.setUint16(32, 2, true);
  wav.setUint16(34, 16, true);
  writeText(output, 36, "data");
  wav.setUint32(40, decodedSize * 2, true);

  const dictionary: (Uint8Array<ArrayBuffer> | undefined)[] = new Array(256);
  let position = audioOffset;
  let emitted = 0;
  let predictor = 0;

  const emit = (code: number): void => {
    if (emitted < decodedSize) {
      predictor += DPCM_STEPS[code] ?? 0;
      predictor = Math.max(-32768, Math.min(32767, predictor));
      wav.setInt16(44 + emitted * 2, predictor, true);
    }
    emitted++;
  };

  while (position < input.length && emitted < decodedSize) {
    const code = input[position];
    if (code >= 0xf4 && code <= 0xf8) {
      const length = code - 0xf3;
      if (position + 2 + length > input.length) {
        throw new Error("A PXD dictionary entry is incomplete.");
      }
      const key = input[position + 1];
      const value = input.slice(position + 2, position + 2 + length);
      dictionary[key] = value;
      for (const valueCode of value) emit(valueCode);
      position += length + 2;
    } else if (code === 0xff) {
      if (position + 1 >= input.length) {
        throw new Error("A PXD audio code is incomplete.");
      }
      emit(input[position + 1]);
      position += 2;
    } else if (code === 0) {
      for (let i = 0; i < 5; i++) emit(0x80);
      position++;
    } else {
      const value = dictionary[code];
      if (value) {
        for (const valueCode of value) emit(valueCode);
      } else {
        emit(code);
      }
      position++;
    }
  }

  if (
    position !== input.length ||
    emitted > decodedSize + 4 ||
    emitted < decodedSize - 1
  ) {
    throw new Error("The PXD audio data is incomplete or too long.");
  }

  // Some complete PXD streams omit one final zero delta code.
  if (emitted === decodedSize - 1) {
    wav.setInt16(44 + emitted * 2, predictor, true);
  }

  return output;
}
