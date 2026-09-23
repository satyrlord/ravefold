import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWav } from "../src/domain/wav.ts";

function wav(
  bits: 16 | 24 | 32,
  channels = 1,
  extended = false,
): Uint8Array<ArrayBuffer> {
  const formatSize = extended ? 40 : 16;
  const dataSize = (bits / 8) * channels * 4;
  const bytes = new Uint8Array(28 + formatSize + dataSize);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      bytes[offset + i] = value.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, formatSize, true);
  view.setUint16(20, extended ? 0xfffe : bits === 32 ? 3 : 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, (48000 * bits * channels) / 8, true);
  view.setUint16(32, (bits * channels) / 8, true);
  view.setUint16(34, bits, true);
  if (extended) {
    view.setUint16(36, 22, true);
    view.setUint16(38, bits, true);
    view.setUint16(44, bits === 32 ? 3 : 1, true);
    view.setUint32(48, 0x00100000, true);
    view.setUint32(52, 0x800000aa, false);
    view.setUint32(56, 0x00389b71, false);
  }
  text(20 + formatSize, "data");
  view.setUint32(24 + formatSize, dataSize, true);
  return bytes;
}

function appendChunk(
  source: Uint8Array<ArrayBuffer>,
  kind: string,
  contents: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const chunk = new Uint8Array(8 + contents.length + (contents.length % 2));
  for (let i = 0; i < 4; i++) chunk[i] = kind.charCodeAt(i);
  new DataView(chunk.buffer).setUint32(4, contents.length, true);
  chunk.set(contents, 8);
  const result = new Uint8Array(source.length + chunk.length);
  result.set(source);
  result.set(chunk, source.length);
  new DataView(result.buffer).setUint32(4, result.length - 8, true);
  return result;
}

function sampler(
  startFrame: number,
  endFrame: number,
  options: {
    count?: number;
    type?: number;
    fraction?: number;
    samplerBytes?: number;
  } = {},
): Uint8Array<ArrayBuffer> {
  const count = options.count ?? 1;
  const extra = options.samplerBytes ?? 0;
  const bytes = new Uint8Array(36 + 24 * count + extra);
  const view = new DataView(bytes.buffer);
  view.setUint32(28, count, true);
  view.setUint32(32, extra, true);
  if (count) {
    view.setUint32(40, options.type ?? 0, true);
    view.setUint32(44, startFrame, true);
    view.setUint32(48, endFrame, true);
    view.setUint32(52, options.fraction ?? 0, true);
  }
  return bytes;
}

for (const bits of [16, 24, 32] as const) {
  for (const channels of [1, 2]) {
    for (const extended of [false, true]) {
      test(`accept ${bits}-bit ${channels}-channel WAV, extended=${extended}`, async () => {
        const result = await validateWav(
          new Blob([wav(bits, channels, extended)]),
        );
        assert.equal(result.valid, true);
        if (result.valid) {
          assert.equal(result.info.frames, 4);
          assert.equal(result.info.channels, channels);
          assert.equal(result.info.sampleRate, 48000);
        }
      });
    }
  }
}

test("reject truncated data and invalid chunk sizes", async () => {
  const bytes = wav(16);
  assert.equal(
    (await validateWav(new Blob([bytes.slice(0, -1)]))).valid,
    false,
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(40, 4096, true);
  assert.equal((await validateWav(new Blob([bytes]))).valid, false);
});

test("reject false extensions, compressed formats and incomplete frames", async () => {
  assert.equal((await validateWav(new Blob(["not a WAV"]))).valid, false);
  const compressed = wav(16);
  new DataView(compressed.buffer).setUint16(20, 2, true);
  assert.equal((await validateWav(new Blob([compressed]))).valid, false);
  const incomplete = wav(24, 2);
  new DataView(incomplete.buffer).setUint32(40, 23, true);
  assert.equal((await validateWav(new Blob([incomplete]))).valid, false);
});

test("reject unsupported channels and invalid format rates", async () => {
  assert.equal((await validateWav(new Blob([wav(16, 3)]))).valid, false);
  const bytes = wav(16);
  new DataView(bytes.buffer).setUint32(28, 1, true);
  assert.equal((await validateWav(new Blob([bytes]))).valid, false);
});

test("reject NaN and infinity in floating-point audio", async () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const bytes = wav(32);
    new DataView(bytes.buffer).setFloat32(44, value, true);
    assert.equal((await validateWav(new Blob([bytes]))).valid, false);
  }
});

test("abort validation before reading audio", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(validateWav(new Blob([wav(16)]), controller.signal), {
    name: "AbortError",
  });
});

test("accept one forward loop with inclusive smpl end and unchanged source bytes", async () => {
  const bytes = appendChunk(
    wav(16),
    "smpl",
    sampler(1, 3, { samplerBytes: 3 }),
  );
  const before = bytes.slice();
  const result = await validateWav(new Blob([bytes]));
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.info.duration, 4 / 48000);
    assert.deepEqual(result.info.loop, {
      startFrame: 1,
      endFrameExclusive: 4,
    });
  }
  assert.deepEqual(bytes, before);
});

test("accept a sampler chunk without a loop and keep unmarked file metadata unchanged", async () => {
  const result = await validateWav(
    new Blob([appendChunk(wav(24), "smpl", sampler(0, 0, { count: 0 }))]),
  );
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(Object.hasOwn(result.info, "loop"), false);
});

test("reject ambiguous or unsupported loop markers", async () => {
  const sources = [
    appendChunk(
      appendChunk(wav(16), "smpl", sampler(0, 3)),
      "smpl",
      sampler(0, 3),
    ),
    appendChunk(wav(16), "smpl", sampler(0, 3, { count: 2 })),
    appendChunk(wav(16), "smpl", sampler(0, 3, { type: 1 })),
    appendChunk(wav(16), "smpl", sampler(0, 3, { fraction: 1 })),
  ];
  for (const bytes of sources) {
    const before = bytes.slice();
    const result = await validateWav(new Blob([bytes]));
    assert.equal(result.valid, false);
    assert.deepEqual(bytes, before);
  }
});

test("reject truncated, contradictory or out-of-range loop markers", async () => {
  const mismatched = sampler(0, 3);
  new DataView(mismatched.buffer).setUint32(32, 4, true);
  const truncated = appendChunk(wav(16), "smpl", sampler(0, 3));
  const sources = [
    appendChunk(wav(16), "smpl", new Uint8Array(35)),
    appendChunk(wav(16), "smpl", mismatched),
    truncated.slice(0, -1),
    appendChunk(wav(16), "smpl", sampler(3, 2)),
    appendChunk(wav(16), "smpl", sampler(0, 4)),
  ];
  for (const bytes of sources) {
    assert.equal((await validateWav(new Blob([bytes]))).valid, false);
  }
});

test("reject unreported trailing bytes outside the RIFF container", async () => {
  const source = wav(16);
  const bytes = new Uint8Array(source.length + 2);
  bytes.set(source);
  assert.equal((await validateWav(new Blob([bytes]))).valid, false);
});
