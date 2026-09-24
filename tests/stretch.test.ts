import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { analyzeAudio } from "../src/audio/analyze.ts";
import { decodeWav } from "../src/audio/pcm.ts";
import { prepareAudio, wavInfo } from "../src/audio/prepare-core.ts";
import { stretchAudio } from "../src/audio/stretch.ts";
import { encodeFloatWav } from "../src/audio/wav-encode.ts";
import { planPreparation } from "../src/domain/preparation.ts";
import { validateWav } from "../src/domain/wav.ts";
import {
  cents,
  measuredFrequency,
  NATURAL,
  phrase,
  RATE,
  tone,
} from "./audio-signals.ts";

test("an 8 kHz source expands to 90 BPM through preparation", async () => {
  const bytes = encodeFloatWav(
    [phrase(120, NATURAL, { sampleRate: 8000 })],
    8000,
    false,
  );
  const decoded = await decodeWav(new Blob([bytes]));
  const plan = planPreparation(analyzeAudio(decoded), wavInfo(decoded));
  assert.equal(plan.valid, true);
  if (!plan.valid) return;
  assert.equal(plan.plan.targetBpm, 90);
  assert.ok(plan.plan.outputFrames > plan.plan.inputFrames);
  const outcome = await prepareAudio(
    bytes,
    createHash("sha256").update(new Uint8Array(bytes)).digest("hex"),
    plan.plan,
    { progress() {}, async checkpoint() {} },
  );
  assert.equal(outcome.status, "validated", JSON.stringify(outcome));
  if (outcome.status !== "validated") return;
  assert.equal(outcome.info.frames, Math.round((8 * 60 * 8000) / 90));
  assert.equal(outcome.analysis.measured.bpm, 90);
  const output = await decodeWav(new Blob([outcome.bytes]));
  assert.ok(output.channels[0]!.every(Number.isFinite));
});

test("output length is exact and latency is compensated for an impulse", async () => {
  for (const ratio of [0.5, 2 / 3, 4 / 3, 2]) {
    const input = new Float32Array(RATE);
    const position = RATE / 2;
    input[position] = 1;
    const outputFrames = Math.round(RATE * ratio);
    const result = await stretchAudio({
      channels: [input],
      sampleRate: RATE,
      outputFrames,
      semitones: 0,
      circular: false,
    });
    const output = result.channels[0]!;
    assert.equal(output.length, outputFrames);
    let peak = 0;
    let at = 0;
    output.forEach((value, index) => {
      if (value * value > peak) {
        peak = value * value;
        at = index;
      }
    });
    let energy = 0;
    let centre = 0;
    for (let index = at - 400; index < at + 400; index++) {
      energy += output[index]! ** 2;
      centre += output[index]! ** 2 * index;
    }
    const error = centre / energy - position * ratio;
    // Phase-vocoder transients can move by up to 1 ms. Length stays exact.
    assert.ok(Math.abs(error) <= RATE * 0.0015, `${ratio}: ${error} frames`);
    assert.ok(result.latencyFrames > 0);
  }
});

test("sustained tones meet the 5 cent pitch criterion at independent durations", async () => {
  let worst = 0;
  for (const frequency of [41.2, 110, 293.66, 1760])
    for (const [ratio, semitones] of [
      [4 / 3, -2],
      [0.5, 5],
      [2, -6],
      [0.75, 3],
    ] as const) {
      const input = tone(frequency, RATE * 2);
      const outputFrames = Math.round(input.length * ratio);
      const { channels } = await stretchAudio({
        channels: [input],
        sampleRate: RATE,
        outputFrames,
        semitones,
        circular: false,
      });
      const output = channels[0]!;
      assert.equal(output.length, outputFrames);
      const measured = measuredFrequency(
        output.subarray(
          Math.round(outputFrames * 0.2),
          Math.round(outputFrames * 0.8),
        ),
      );
      const error = cents(measured, frequency * 2 ** (semitones / 12));
      worst = Math.max(worst, Math.abs(error));
    }
  assert.ok(worst <= 5, `${worst} cents`);
});

test("a tempo change without a semitone shift keeps pitch", async () => {
  for (const ratio of [0.5, 4 / 3, 2]) {
    const input = tone(220, RATE * 2);
    const { channels } = await stretchAudio({
      channels: [input],
      sampleRate: RATE,
      outputFrames: Math.round(input.length * ratio),
      semitones: 0,
      circular: false,
    });
    const output = channels[0]!;
    const measured = measuredFrequency(
      output.subarray(
        Math.round(output.length * 0.2),
        Math.round(output.length * 0.8),
      ),
    );
    assert.ok(Math.abs(cents(measured, 220)) <= 1, `${ratio}: ${measured}`);
  }
});

test("stereo channels are processed together and keep their alignment", async () => {
  const left = tone(330, RATE);
  const right = new Float32Array(left.length);
  const delay = 12;
  for (let frame = delay; frame < right.length; frame++)
    right[frame] = left[frame - delay]! * 0.5;
  const ratio = 4 / 3;
  const { channels } = await stretchAudio({
    channels: [left, right],
    sampleRate: RATE,
    outputFrames: Math.round(left.length * ratio),
    semitones: 0,
    circular: false,
  });
  const [outLeft, outRight] = channels as [Float32Array, Float32Array];
  const start = Math.round(outLeft.length * 0.3);
  const span = 4096;
  let bestLag = 0;
  let best = -Infinity;
  for (let lag = 0; lag < 40; lag++) {
    let sum = 0;
    for (let index = 0; index < span; index++)
      sum += outLeft[start + index]! * outRight[start + index + lag]!;
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  assert.ok(Math.abs(bestLag - delay) <= 1, `lag ${bestLag}`);
  let leftPower = 0;
  let rightPower = 0;
  for (let index = 0; index < span; index++) {
    leftPower += outLeft[start + index]! ** 2;
    rightPower += outRight[start + index + bestLag]! ** 2;
  }
  assert.ok(Math.abs(Math.sqrt(rightPower / leftPower) - 0.5) < 0.02);
});

test("a circular loop keeps full level at both boundaries", async () => {
  const input = tone(400, RATE);
  const level = (audio: Float32Array, from: number) => {
    let power = 0;
    for (let index = from; index < from + 512; index++)
      power += audio[index]! ** 2;
    return Math.sqrt(power / 512);
  };
  for (const semitones of [0, -2]) {
    const edges = async (circular: boolean) => {
      const { channels } = await stretchAudio({
        channels: [input],
        sampleRate: RATE,
        outputFrames: Math.round(RATE * 0.75),
        semitones,
        circular,
      });
      const output = channels[0]!;
      const middle = level(output, Math.round(output.length / 2));
      return [level(output, 0), level(output, output.length - 512)].map(
        (value) => value / middle,
      );
    };
    const circular = await edges(true);
    const linear = await edges(false);
    for (const ratio of circular)
      assert.ok(Math.abs(ratio - 1) < 0.05, `circular edges ${circular}`);
    assert.ok(linear[1]! < circular[1]!, `linear edges ${linear}`);
  }
});

test("float WAV output keeps channels, length and a full loop marker", async () => {
  const left = tone(220, 4800);
  const right = left.map((value) => -value);
  const bytes = encodeFloatWav([left, right], RATE, true);
  const checked = await validateWav(new Blob([bytes]));
  assert.equal(checked.valid, true);
  if (!checked.valid) return;
  assert.deepEqual(checked.info.loop, {
    startFrame: 0,
    endFrameExclusive: 4800,
  });
  const decoded = await decodeWav(new Blob([bytes]));
  assert.equal(decoded.channels.length, 2);
  assert.deepEqual(decoded.channels[1], right);
  assert.throws(() => encodeFloatWav([left, new Float32Array(3)], RATE, false));
});
