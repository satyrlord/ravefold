import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateStereoPair,
  type StereoPairEvidence,
  type StereoPairSource,
} from "../src/domain/stereo-pair.ts";

interface WavOptions {
  frames?: number;
  sampleRate?: number;
  channels?: number;
  bits?: 16 | 24;
  loop?: { startFrame: number; endFrame: number };
  seed?: number;
  pulses?: number[];
  silent?: boolean;
}

function wav(options: WavOptions = {}): Uint8Array<ArrayBuffer> {
  const frames = options.frames ?? 48_000;
  const sampleRate = options.sampleRate ?? 48_000;
  const channels = options.channels ?? 1;
  const bits = options.bits ?? 16;
  const dataSize = frames * channels * (bits / 8);
  const padding = dataSize % 2;
  const bytes = new Uint8Array(
    44 + dataSize + padding + (options.loop ? 68 : 0),
  );
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      bytes[offset + index] = value.charCodeAt(index);
  };
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bits / 8), true);
  view.setUint16(32, channels * (bits / 8), true);
  view.setUint16(34, bits, true);
  tag(36, "data");
  view.setUint32(40, dataSize, true);
  const audio = new Float32Array(frames);
  let seed = options.seed ?? 1;
  for (const seconds of options.silent
    ? []
    : (options.pulses ?? [0.1, 0.3, 0.5, 0.7])) {
    const start = Math.round(seconds * sampleRate);
    const active = Math.min(Math.round(sampleRate * 0.035), frames - start);
    for (let frame = 0; frame < active; frame++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const random = (seed >>> 0) / 0xffffffff;
      const envelope = Math.exp((-8 * frame) / active);
      audio[start + frame] = (random * 2 - 1) * envelope * 0.75;
    }
  }
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const offset = 44 + (frame * channels + channel) * (bits / 8);
      if (bits === 16) {
        view.setInt16(offset, Math.round(audio[frame]! * 32767), true);
      } else {
        const value = Math.round(audio[frame]! * 8388607);
        bytes[offset] = value & 0xff;
        bytes[offset + 1] = (value >> 8) & 0xff;
        bytes[offset + 2] = (value >> 16) & 0xff;
      }
    }
  }
  if (options.loop) {
    const offset = 44 + dataSize + padding;
    tag(offset, "smpl");
    view.setUint32(offset + 4, 60, true);
    view.setUint32(offset + 8 + 28, 1, true);
    view.setUint32(offset + 8 + 44, options.loop.startFrame, true);
    view.setUint32(offset + 8 + 48, options.loop.endFrame, true);
  }
  return bytes;
}

function source(path: string, options: WavOptions = {}): StereoPairSource {
  return { path, file: new Blob([wav(options)], { type: "audio/wav" }) };
}

async function digest(file: Blob): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function evidence(
  left: StereoPairSource,
  right: StereoPairSource,
): Promise<StereoPairEvidence> {
  return {
    provenanceId: "source-catalog-record-1",
    channelOrder: "left-right",
    frameOffset: 0,
    left: { path: left.path, sha256: await digest(left.file) },
    right: { path: right.path, sha256: await digest(right.file) },
  };
}

test("accept explicit unmarked pair without changing either source", async () => {
  const left = source("Parts/left.wav", { seed: 17 });
  const right = source("Parts/right.wav", { seed: 93 });
  const leftBefore = new Uint8Array(await left.file.arrayBuffer());
  const rightBefore = new Uint8Array(await right.file.arrayBuffer());
  const result = await validateStereoPair(
    left,
    right,
    await evidence(left, right),
  );
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.info.frames, 48_000);
    assert.equal(result.info.sampleRate, 48_000);
    assert.equal(result.info.loop, undefined);
    assert.equal(result.info.provenanceId, "source-catalog-record-1");
    assert.match(
      result.reason,
      /channel attacks align in the same 1 ms blocks/i,
    );
    assert.equal("ready" in result, false);
  }
  assert.deepEqual(new Uint8Array(await left.file.arrayBuffer()), leftBefore);
  assert.deepEqual(new Uint8Array(await right.file.arrayBuffer()), rightBefore);
});

test("accept equal validated loop markers", async () => {
  const loop = { startFrame: 0, endFrame: 47_999 };
  const left = source("left.wav", { loop });
  const right = source("right.wav", { loop, seed: 2 });
  const result = await validateStereoPair(
    left,
    right,
    await evidence(left, right),
  );
  assert.equal(result.valid, true);
  if (result.valid)
    assert.deepEqual(result.info.loop, {
      startFrame: 0,
      endFrameExclusive: 48_000,
    });
});

test("reject missing or contradictory source evidence", async () => {
  const left = source("left.wav");
  const right = source("right.wav", { seed: 2 });
  const proof = await evidence(left, right);
  const cases: Array<{
    name: string;
    value: StereoPairEvidence | null;
    reason: RegExp;
  }> = [
    { name: "no evidence", value: null, reason: /evidence is required/i },
    {
      name: "no provenance",
      value: { ...proof, provenanceId: "  " },
      reason: /provenance ID is required/i,
    },
    {
      name: "wrong channel order",
      value: { ...proof, channelOrder: "right-left" },
      reason: /left then right channel order/i,
    },
    {
      name: "swapped source paths",
      value: { ...proof, left: proof.right, right: proof.left },
      reason: /paths do not match/i,
    },
    {
      name: "nonzero offset",
      value: { ...proof, frameOffset: 1 },
      reason: /zero frame offset/i,
    },
    {
      name: "wrong hash",
      value: { ...proof, left: { ...proof.left, sha256: "0".repeat(64) } },
      reason: /left source does not match/i,
    },
    {
      name: "malformed hash",
      value: { ...proof, right: { ...proof.right, sha256: "bad" } },
      reason: /valid SHA-256/i,
    },
  ];
  for (const item of cases) {
    const result = await validateStereoPair(left, right, item.value);
    assert.equal(result.valid, false, item.name);
    assert.match(result.reason, item.reason, item.name);
  }
});

test("reject duplicate paths and unsupported or damaged files", async () => {
  const left = source("left.wav");
  const samePath = source("LEFT.wav", { seed: 2 });
  const duplicate = await validateStereoPair(
    left,
    samePath,
    await evidence(left, samePath),
  );
  assert.equal(duplicate.valid, false);
  assert.match(duplicate.reason, /different paths/i);

  const stereo = source("right.wav", { channels: 2 });
  const stereoResult = await validateStereoPair(
    left,
    stereo,
    await evidence(left, stereo),
  );
  assert.equal(stereoResult.valid, false);
  assert.match(stereoResult.reason, /two mono WAV/i);

  const damaged = { path: "right.wav", file: new Blob(["not a WAV"]) };
  const damagedResult = await validateStereoPair(
    left,
    damaged,
    await evidence(left, damaged),
  );
  assert.equal(damagedResult.valid, false);
  assert.match(damagedResult.reason, /right WAV is invalid/i);
});

test("reject different frame counts, sample rates, and encodings", async () => {
  const left = source("left.wav");
  const cases: Array<{ name: string; options: WavOptions; reason: RegExp }> = [
    { name: "length", options: { frames: 7 }, reason: /frame counts/i },
    {
      name: "sample rate",
      options: { sampleRate: 44_100 },
      reason: /sample rates/i,
    },
    { name: "encoding", options: { bits: 24 }, reason: /encodings/i },
  ];
  for (const item of cases) {
    const right = source("right.wav", item.options);
    const result = await validateStereoPair(
      left,
      right,
      await evidence(left, right),
    );
    assert.equal(result.valid, false, item.name);
    assert.match(result.reason, item.reason, item.name);
  }
});

test("hold a sample rate with insufficient onset resolution", async () => {
  const left = source("left.wav", { frames: 500, sampleRate: 500 });
  const right = source("right.wav", {
    frames: 500,
    sampleRate: 500,
    seed: 2,
  });
  const result = await validateStereoPair(
    left,
    right,
    await evidence(left, right),
  );
  assert.equal(result.valid, false);
  assert.match(result.reason, /millisecond alignment/i);
});

test("reject one-sided and unequal loop markers", async () => {
  const left = source("left.wav", {
    loop: { startFrame: 0, endFrame: 47_999 },
  });
  const cases = [
    source("right.wav"),
    source("right.wav", { loop: { startFrame: 1, endFrame: 47_999 } }),
  ];
  for (const right of cases) {
    const result = await validateStereoPair(
      left,
      right,
      await evidence(left, right),
    );
    assert.equal(result.valid, false);
    assert.match(result.reason, /loop boundaries do not match/i);
  }
});

test("reject shifted or unrelated channel attacks despite valid source evidence", async () => {
  const left = source("left.wav", { seed: 17 });
  const cases = [
    source("right.wav", { seed: 93, pulses: [0.101, 0.301, 0.501, 0.701] }),
    source("right.wav", { seed: 93, pulses: [0.11, 0.31, 0.51, 0.71] }),
    source("right.wav", { seed: 93, pulses: [0.1, 0.41, 0.61, 0.81] }),
  ];
  for (const right of cases) {
    const result = await validateStereoPair(
      left,
      right,
      await evidence(left, right),
    );
    assert.equal(result.valid, false);
    assert.match(result.reason, /onsets do not align/i);
  }
});

test("hold quiet or short-onset audio for review", async () => {
  const left = source("left.wav");
  const cases = [
    source("right.wav", { silent: true }),
    source("right.wav", { pulses: [0.1] }),
  ];
  for (const right of cases) {
    const result = await validateStereoPair(
      left,
      right,
      await evidence(left, right),
    );
    assert.equal(result.valid, false);
    assert.match(result.reason, /too few clear onsets/i);
  }
});
