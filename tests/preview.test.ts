import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SourcePreview,
  MAX_SOURCE_BYTES,
  type PreviewAudio,
  type PreviewBuffer,
  type PreviewState,
} from "../src/library/preview.ts";
import type { SampleFile } from "../src/storage/folders.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function sample(path: string, frames = 4, sampleRate = 48000) {
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++)
      bytes[offset + index] = text.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  write(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, frames * 2, true);
  let reads = 0;
  let writes = 0;
  const entry: SampleFile = {
    path,
    info: {
      encoding: "pcm16",
      channels: 1,
      sampleRate,
      frames,
      duration: frames / sampleRate,
    },
    handle: {
      kind: "file",
      name: path.split("/").at(-1)!,
      isSameEntry: async (other) => entry.handle === other,
      getFile: async () => {
        reads++;
        return new File([bytes], entry.handle.name);
      },
      createWritable: async () => {
        writes++;
        throw new Error("Audio writes are forbidden.");
      },
    },
  };
  return { entry, bytes, reads: () => reads, writes: () => writes };
}

class FakeAudio implements PreviewAudio {
  state = "running";
  resumes = 0;
  closes = 0;
  decoding = 0;
  maxDecoding = 0;
  decoded: ArrayBuffer[] = [];
  active = new Set<number>();
  stopped: number[] = [];
  ended = new Map<number, () => void>();
  gate: Promise<void> | undefined;
  resumeGate: Promise<void> | undefined;
  failDecode: Error | undefined;
  channels = [new Float32Array([0, -0.25, 0.5, -1])];

  async resume(): Promise<void> {
    this.resumes++;
    await this.resumeGate;
  }

  async close(): Promise<void> {
    this.closes++;
    this.state = "closed";
  }

  async decode(bytes: ArrayBuffer): Promise<PreviewBuffer> {
    const index = this.decoded.length;
    this.decoded.push(bytes);
    this.decoding++;
    this.maxDecoding = Math.max(this.maxDecoding, this.decoding);
    await this.gate;
    this.decoding--;
    if (this.failDecode) throw this.failDecode;
    return {
      duration: 1,
      channels: this.channels,
      start: (onEnded) => {
        this.active.add(index);
        this.ended.set(index, onEnded);
        return {
          stop: () => {
            this.active.delete(index);
            this.stopped.push(index);
          },
        };
      },
    };
  }

  finish(index: number): void {
    this.active.delete(index);
    this.ended.get(index)?.();
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("The expected operation did not start.");
}

test("audio stays lazy and source audition leaves source and readiness unchanged", async () => {
  const source = sample("Drums/kick.wav");
  const before = structuredClone(source.entry.info);
  const bytes = source.bytes.slice();
  const audio = new FakeAudio();
  let created = 0;
  const preview = new SourcePreview({
    createAudio: () => {
      created++;
      return audio;
    },
  });
  assert.equal(created, 0);
  assert.equal(source.reads(), 0);
  await preview.play(source.entry);
  assert.equal(created, 1);
  assert.equal(source.reads(), 1);
  assert.equal(audio.decoded.length, 1);
  assert.deepEqual(new Uint8Array(audio.decoded[0]), bytes);
  assert.deepEqual(source.entry.info, before);
  assert.deepEqual(source.bytes, bytes);
  assert.equal(source.writes(), 0);
  assert.equal("status" in source.entry, false);
  assert.equal(preview.getState().status, "playing");
  preview.dispose();
});

test("a different source immediately stops the previous source", async () => {
  const audio = new FakeAudio();
  const preview = new SourcePreview({ createAudio: () => audio });
  await preview.play(sample("one/kick.wav").entry);
  const next = preview.play(sample("two/kick.wav").entry);
  assert.equal(audio.active.size, 0);
  assert.deepEqual(audio.stopped, [0]);
  await next;
  assert.deepEqual([...audio.active], [1]);
  assert.equal(preview.getState().path, "two/kick.wav");
  audio.finish(0);
  assert.equal(preview.getState().status, "playing");
  audio.finish(1);
  assert.equal(preview.getState().status, "idle");
  preview.dispose();
});

test("only the latest queued source plays after a pending decode", async () => {
  const audio = new FakeAudio();
  const gate = deferred<void>();
  audio.gate = gate.promise;
  const preview = new SourcePreview({ createAudio: () => audio });
  const first = preview.play(sample("first.wav").entry);
  await until(() => audio.decoded.length === 1);
  const skipped = sample("skipped.wav");
  const second = preview.play(skipped.entry);
  const third = preview.play(sample("latest.wav").entry);
  gate.resolve();
  await Promise.all([first, second, third]);
  assert.equal(skipped.reads(), 0);
  assert.equal(audio.decoded.length, 2);
  assert.equal(audio.maxDecoding, 1);
  assert.deepEqual([...audio.active], [1]);
  assert.equal(preview.getState().path, "latest.wav");
  preview.dispose();
});

test("a stale resume cannot start the earlier source", async () => {
  const audio = new FakeAudio();
  const gate = deferred<void>();
  audio.state = "suspended";
  audio.resumeGate = gate.promise;
  const preview = new SourcePreview({ createAudio: () => audio });
  const old = sample("old.wav");
  const first = preview.play(old.entry);
  assert.equal(audio.resumes, 1);
  audio.state = "running";
  await preview.play(sample("latest.wav").entry);
  gate.resolve();
  await first;
  assert.equal(old.reads(), 0);
  assert.equal(audio.decoded.length, 1);
  assert.equal(preview.getState().path, "latest.wav");
  preview.dispose();
});

test("stop invalidates pending decode without a later playback", async () => {
  const audio = new FakeAudio();
  const gate = deferred<void>();
  audio.gate = gate.promise;
  const preview = new SourcePreview({ createAudio: () => audio });
  const pending = preview.play(sample("pending.wav").entry);
  await until(() => audio.decoded.length === 1);
  preview.stop();
  gate.resolve();
  await pending;
  assert.equal(audio.active.size, 0);
  assert.equal(preview.getState().status, "idle");
  preview.dispose();
});

test("dispose stops audio and suppresses pending state updates", async () => {
  const audio = new FakeAudio();
  const states: PreviewState[] = [];
  const preview = new SourcePreview({
    createAudio: () => audio,
    onChange: (state) => states.push(state),
  });
  await preview.play(sample("first.wav").entry);
  const gate = deferred<void>();
  audio.gate = gate.promise;
  const pending = preview.play(sample("pending.wav").entry);
  await until(() => audio.decoded.length === 2);
  preview.dispose();
  const count = states.length;
  gate.resolve();
  await pending;
  await preview.play(sample("after-dispose.wav").entry);
  assert.equal(states.length, count);
  assert.equal(audio.active.size, 0);
  assert.deepEqual(audio.stopped, [0]);
  assert.equal(audio.closes, 1);
  preview.dispose();
  assert.equal(audio.closes, 1);
});

test("waveform is explicit, includes both channels and does not start or resume audio", async () => {
  const audio = new FakeAudio();
  audio.state = "suspended";
  audio.channels = [
    new Float32Array([0, -0.25, 0.5, -1]),
    new Float32Array([0.1, 0.75, -0.25, 0]),
  ];
  const preview = new SourcePreview({ createAudio: () => audio });
  const source = sample("stereo.wav");
  assert.equal(audio.decoded.length, 0);
  const waveform = await preview.waveform(source.entry);
  assert.ok(waveform);
  assert.equal(waveform.path, "stereo.wav");
  assert.deepEqual(waveform.peaks, [Math.fround(0.1), 0.75, 0.5, 1]);
  assert.equal(waveform.duration, 1);
  assert.equal(audio.resumes, 0);
  assert.equal(audio.active.size, 0);
  assert.equal(source.writes(), 0);
  assert.equal(preview.getState().status, "idle");
  preview.dispose();
});

test("waveforms combine frames into bounded peak columns", async () => {
  const audio = new FakeAudio();
  audio.channels = [new Float32Array(512)];
  audio.channels[0][128] = -0.8;
  const preview = new SourcePreview({ createAudio: () => audio });
  const waveform = await preview.waveform(sample("long.wav").entry);
  assert.ok(waveform);
  assert.equal(waveform.peaks.length, 256);
  assert.equal(waveform.peaks[64], Math.fround(0.8));
  preview.dispose();
});

test("cancel and newer waveform requests discard stale decoded data", async () => {
  const audio = new FakeAudio();
  const gate = deferred<void>();
  audio.gate = gate.promise;
  const preview = new SourcePreview({ createAudio: () => audio });
  const first = preview.waveform(sample("first.wav").entry);
  await until(() => audio.decoded.length === 1);
  const skipped = sample("skipped.wav");
  const second = preview.waveform(skipped.entry);
  preview.cancelWaveform();
  gate.resolve();
  assert.equal(await first, null);
  assert.equal(await second, null);
  assert.equal(skipped.reads(), 0);
  assert.equal(audio.active.size, 0);
  preview.dispose();
});

test("source preview survives a waveform request for another sample", async () => {
  const audio = new FakeAudio();
  const preview = new SourcePreview({ createAudio: () => audio });
  await preview.play(sample("audition.wav").entry);
  await preview.waveform(sample("inspect.wav").entry);
  assert.deepEqual([...audio.active], [0]);
  assert.equal(preview.getState().path, "audition.wav");
  preview.dispose();
});

test("unavailable and suspended audio states leave recoverable errors", async () => {
  const unavailable = new SourcePreview({
    createAudio: () => {
      throw new Error("Source preview is unavailable in this browser.");
    },
  });
  await unavailable.play(sample("source.wav").entry);
  assert.equal(unavailable.getState().status, "error");
  assert.match(unavailable.getState().message, /unavailable/);
  const audio = new FakeAudio();
  audio.state = "suspended";
  const preview = new SourcePreview({ createAudio: () => audio });
  await preview.play(sample("source.wav").entry);
  assert.equal(preview.getState().status, "error");
  assert.match(preview.getState().message, /suspended/);
  assert.equal(audio.decoded.length, 0);
  audio.state = "running";
  await preview.play(sample("source.wav").entry);
  assert.equal(preview.getState().status, "playing");
  preview.dispose();
});

test("a decode failure does not prevent a subsequent preview", async () => {
  const audio = new FakeAudio();
  audio.failDecode = new Error("The audio could not be decoded.");
  const preview = new SourcePreview({ createAudio: () => audio });
  await preview.play(sample("first.wav").entry);
  assert.equal(preview.getState().status, "error");
  audio.failDecode = undefined;
  await preview.play(sample("second.wav").entry);
  assert.equal(preview.getState().status, "playing");
  preview.dispose();
});

test("a changed file must still pass WAV validation before decode", async () => {
  const audio = new FakeAudio();
  const source = sample("changed.wav");
  source.bytes[0] = 0;
  const preview = new SourcePreview({ createAudio: () => audio });
  await preview.play(source.entry);
  assert.equal(preview.getState().status, "error");
  assert.equal(audio.decoded.length, 0);
  assert.equal(source.writes(), 0);
  preview.dispose();
});

test("source limits reject large reads and long WAV files before audio decode", async () => {
  const audio = new FakeAudio();
  const preview = new SourcePreview({ createAudio: () => audio });
  const oversized = sample("large.wav");
  oversized.entry.handle.getFile = async () =>
    new (class extends File {
      override get size() {
        return MAX_SOURCE_BYTES + 1;
      }
      override slice(): Blob {
        assert.fail("Oversized audio must not be read.");
      }
    })([], "large.wav");
  await preview.play(oversized.entry);
  assert.equal(preview.getState().status, "error");
  assert.match(preview.getState().message, /100 MiB/);
  await assert.rejects(
    preview.waveform(sample("long.wav", 301, 1).entry),
    /five minutes/,
  );
  assert.equal(audio.decoded.length, 0);
  await preview.play(sample("allowed.wav", 300, 1).entry);
  assert.equal(audio.decoded.length, 1);
  assert.equal(preview.getState().status, "playing");
  preview.dispose();
});

test("a cancelled waveform ignores a stale decoder failure", async () => {
  const audio = new FakeAudio();
  const gate = deferred<void>();
  audio.gate = gate.promise;
  audio.failDecode = new Error("The earlier source failed.");
  const preview = new SourcePreview({ createAudio: () => audio });
  const pending = preview.waveform(sample("old.wav").entry);
  await until(() => audio.decoded.length === 1);
  preview.cancelWaveform();
  gate.resolve();
  assert.equal(await pending, null);
  preview.dispose();
});
