import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeWav,
  MAX_DECODE_WAV_BYTES,
  type DecodedWav,
} from "../src/audio/pcm.ts";

type Encoding = DecodedWav["encoding"];

function wav(
  encoding: Encoding,
  samples: number[][],
  sampleRate = 48000,
): Uint8Array<ArrayBuffer> {
  const bits = encoding === "pcm16" ? 16 : encoding === "pcm24" ? 24 : 32;
  const sampleBytes = bits / 8;
  const frameBytes = sampleBytes * samples.length;
  const frames = samples[0]?.length ?? 0;
  const dataBytes = frameBytes * frames;
  const bytes = new Uint8Array(44 + dataBytes + (dataBytes % 2));
  const view = new DataView(bytes.buffer);
  const label = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      bytes[offset + index] = value.charCodeAt(index);
  };
  label(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  label(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, encoding === "float32" ? 3 : 1, true);
  view.setUint16(22, samples.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * frameBytes, true);
  view.setUint16(32, frameBytes, true);
  view.setUint16(34, bits, true);
  label(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < samples.length; channel++) {
      const value = samples[channel][frame];
      const offset = 44 + frame * frameBytes + channel * sampleBytes;
      if (encoding === "pcm16") view.setInt16(offset, value, true);
      else if (encoding === "pcm24") {
        bytes[offset] = value & 0xff;
        bytes[offset + 1] = (value >> 8) & 0xff;
        bytes[offset + 2] = (value >> 16) & 0xff;
      } else view.setFloat32(offset, value, true);
    }
  }
  return bytes;
}

function appendChunk(
  source: Uint8Array<ArrayBuffer>,
  label: string,
  body: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const chunk = new Uint8Array(8 + body.length + (body.length % 2));
  const view = new DataView(chunk.buffer);
  for (let index = 0; index < 4; index++)
    chunk[index] = label.charCodeAt(index);
  view.setUint32(4, body.length, true);
  chunk.set(body, 8);
  const bytes = new Uint8Array(source.length + chunk.length);
  bytes.set(source);
  bytes.set(chunk, source.length);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  return bytes;
}

function chunkBeforeData(
  source: Uint8Array<ArrayBuffer>,
  label: string,
  body: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const appended = appendChunk(source, label, body);
  const chunk = appended.subarray(source.length);
  const bytes = new Uint8Array(appended.length);
  bytes.set(source.subarray(0, 36));
  bytes.set(chunk, 36);
  bytes.set(source.subarray(36), 36 + chunk.length);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  return bytes;
}

for (const encoding of ["pcm16", "pcm24", "float32"] as const) {
  for (const channelCount of [1, 2]) {
    test(`decode ${encoding} in ${channelCount} channel(s) without changing bytes`, async () => {
      const input =
        encoding === "pcm16"
          ? [-32768, 0, 32767]
          : encoding === "pcm24"
            ? [-8388608, 0, 8388607]
            : [-1.25, 0, 1.25];
      const source = Array.from({ length: channelCount }, (_, index) =>
        index === 0 ? input : [...input].reverse(),
      );
      const bytes = wav(encoding, source);
      const before = bytes.slice();
      const result = await decodeWav(new Blob([bytes]));
      const scale =
        encoding === "pcm16" ? 32768 : encoding === "pcm24" ? 8388608 : 1;
      assert.equal(result.encoding, encoding);
      assert.equal(result.sampleRate, 48000);
      assert.equal(result.frames, 3);
      assert.equal(result.channels.length, channelCount);
      assert.equal(Object.hasOwn(result, "loop"), false);
      for (let channel = 0; channel < channelCount; channel++) {
        assert.deepEqual(
          Array.from(result.channels[channel]),
          source[channel].map((value) => Math.fround(value / scale)),
        );
      }
      assert.deepEqual(bytes, before);
    });
  }
}

test("return validated loop frames without changing the source", async () => {
  const marker = new Uint8Array(60);
  const view = new DataView(marker.buffer);
  view.setUint32(28, 1, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, 2, true);
  const bytes = appendChunk(wav("pcm16", [[0, 100, -100]]), "smpl", marker);
  const before = bytes.slice();
  const result = await decodeWav(new Blob([bytes]));
  assert.deepEqual(result.loop, { startFrame: 1, endFrameExclusive: 3 });
  assert.deepEqual(bytes, before);
});

test("find PCM data after an odd-size metadata chunk", async () => {
  const bytes = chunkBeforeData(
    wav("pcm16", [[-32768, 32767]]),
    "JUNK",
    Uint8Array.of(7),
  );
  const result = await decodeWav(new Blob([bytes]));
  assert.deepEqual(Array.from(result.channels[0]), [-1, 32767 / 32768]);
});

test("reject malformed or nonfinite input without changing the source", async () => {
  const truncated = wav("pcm16", [[1, 2, 3]]).slice(0, -1);
  const invalidChannels = wav("pcm16", [[1, 2, 3]]);
  new DataView(invalidChannels.buffer).setUint16(22, 3, true);
  const nonfinite = wav("float32", [[0, 1, 2]]);
  new DataView(nonfinite.buffer).setFloat32(48, Infinity, true);
  for (const bytes of [truncated, invalidChannels, nonfinite]) {
    const before = bytes.slice();
    await assert.rejects(decodeWav(new Blob([bytes])));
    assert.deepEqual(bytes, before);
  }
});

test("reject a source above the byte or duration limit", async () => {
  const oversized = new Blob([]);
  Object.defineProperty(oversized, "size", { value: MAX_DECODE_WAV_BYTES + 1 });
  await assert.rejects(decodeWav(oversized), /100 MiB/);
  await assert.rejects(
    decodeWav(new Blob([wav("pcm16", [Array<number>(301).fill(0)], 1)])),
    /five minutes/,
  );
});

test("read audio in bounded blocks", async () => {
  class RecordingBlob extends Blob {
    largestRead = 0;
    override slice(start?: number, end?: number, contentType?: string): Blob {
      this.largestRead = Math.max(
        this.largestRead,
        (end ?? this.size) - (start ?? 0),
      );
      return super.slice(start, end, contentType);
    }
  }
  const file = new RecordingBlob([
    wav("pcm16", [Array<number>(150000).fill(0)]),
  ]);
  const result = await decodeWav(file);
  assert.equal(result.frames, 150000);
  assert.ok(file.largestRead <= 262144);
});

test("respect cancellation before and during PCM reads", async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    decodeWav(new Blob([wav("pcm16", [[0]])]), before.signal),
    {
      name: "AbortError",
    },
  );

  const during = new AbortController();
  class InterruptingBlob extends Blob {
    override slice(start?: number, end?: number, contentType?: string): Blob {
      if (start === 44) during.abort();
      return super.slice(start, end, contentType);
    }
  }
  await assert.rejects(
    decodeWav(new InterruptingBlob([wav("pcm16", [[1, 2, 3]])]), during.signal),
    { name: "AbortError" },
  );
});
