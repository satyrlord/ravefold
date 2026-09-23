import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePxdToWav } from "../src/archive/pxd.ts";
import { validateWav } from "../src/domain/wav.ts";

function pxd(
  audio: number[],
  decodedSize: number,
  metadata = "AB",
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(5 + metadata.length + 7 + audio.length);
  bytes.set(new TextEncoder().encode("tPxD"));
  bytes[4] = metadata.length;
  bytes.set(new TextEncoder().encode(metadata), 5);
  const marker = 5 + metadata.length;
  bytes[marker] = 0x54;
  new DataView(bytes.buffer).setUint32(marker + 1, decodedSize, true);
  bytes.set(audio, marker + 7);
  return bytes;
}

function samples(wav: Uint8Array<ArrayBuffer>): number[] {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const values: number[] = [];
  for (let offset = 44; offset < wav.length; offset += 2) {
    values.push(view.getInt16(offset, true));
  }
  return values;
}

test("decode dictionary entries, references, escapes and silence", async () => {
  const encoded = pxd([0xf5, 0x10, 0x80, 0x81, 0x10, 0xff, 0x00, 0x00], 10);
  const padded = new Uint8Array(encoded.length + 4);
  padded.set(encoded, 2);
  const wav = decodePxdToWav(padded.subarray(2, 2 + encoded.length));

  assert.deepEqual(samples(wav), [0, 2, 2, 4, 4, 4, 4, 4, 4, 4]);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), "RIFF");
  assert.equal(new DataView(wav.buffer).getUint32(40, true), 20);
  assert.deepEqual(await validateWav(new Blob([wav])), {
    valid: true,
    info: {
      encoding: "pcm16",
      channels: 1,
      sampleRate: 44_100,
      frames: 10,
      duration: 10 / 44_100,
    },
  });
});

test("clamp the running predictor after each delta", () => {
  const wav = decodePxdToWav(pxd([0xf3, 0xf3, 0xf3, 0x01], 4));
  assert.deepEqual(samples(wav), [16500, 32767, 32767, 7501]);
});

test("accept a final command that crosses the declared audio length", () => {
  assert.deepEqual(samples(decodePxdToWav(pxd([0x00], 3))), [0, 0, 0]);
});

test("add the one implicit final zero delta code used by some PXD files", () => {
  assert.deepEqual(samples(decodePxdToWav(pxd([0x81, 0x81], 3))), [2, 4, 4]);
});

test("decode a headerless audio record with zero reserved bytes", () => {
  const standard = pxd([0x80, 0x81, 0x82], 3);
  const record = standard.slice(7);
  assert.equal(record[0], 0x54);
  assert.deepEqual(decodePxdToWav(record), decodePxdToWav(standard));

  record[5] = 1;
  assert.throws(() => decodePxdToWav(record), /header/);
  assert.throws(() => decodePxdToWav(record.subarray(0, 7)), /header/);
});

test("copy only valid mono PCM16 WAV files at 44.1 kHz", async () => {
  const source = decodePxdToWav(pxd([0x80, 0x81], 2));
  const copy = decodePxdToWav(source);
  assert.deepEqual(copy, source);
  assert.notStrictEqual(copy.buffer, source.buffer);
  assert.equal((await validateWav(new Blob([copy]))).valid, true);

  const wrongRate = source.slice();
  new DataView(wrongRate.buffer).setUint32(24, 48_000, true);
  assert.throws(() => decodePxdToWav(wrongRate), /not supported/);
  const incomplete = source.slice();
  new DataView(incomplete.buffer).setUint32(40, 4_096, true);
  assert.throws(() => decodePxdToWav(incomplete), /incomplete/);
  assert.throws(() => decodePxdToWav(source.subarray(0, -1)), /size/);
});

test("reject malformed headers and decoded sizes", () => {
  assert.throws(() => decodePxdToWav(new Uint8Array(0)), /header/);
  const wrongMagic = pxd([0x81], 1);
  wrongMagic[0] = 0;
  assert.throws(() => decodePxdToWav(wrongMagic), /header/);
  const wrongMarker = pxd([0x81], 1);
  wrongMarker[7] = 0;
  assert.throws(() => decodePxdToWav(wrongMarker), /header/);
  const badSize = pxd([0x81], 1);
  new DataView(badSize.buffer).setUint32(8, 64 * 1024 * 1024 + 1, true);
  assert.throws(() => decodePxdToWav(badSize), /size/);
  assert.throws(() => decodePxdToWav(pxd([0x81], 10)), /size/);
});

test("reject incomplete codes, excess data and long shortfalls", () => {
  assert.throws(() => decodePxdToWav(pxd([0xff], 1)), /incomplete/);
  assert.throws(() => decodePxdToWav(pxd([0xf5, 0x10, 0x81], 2)), /incomplete/);
  assert.throws(() => decodePxdToWav(pxd([0x81, 0x81], 4)), /incomplete/);
  assert.throws(() => decodePxdToWav(pxd([0x81, 0x81], 1)), /too long/);
});
