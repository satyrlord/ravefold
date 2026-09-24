import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { analyzeAudio } from "../src/audio/analyze.ts";
import type { AudioAnalysisReply } from "../src/audio/analyze-worker.ts";
import { decodeWav } from "../src/audio/pcm.ts";
import { wavInfo } from "../src/audio/prepare-core.ts";
import { parseAudioManifest } from "../src/domain/audio-manifest.ts";
import {
  planPreparation,
  PREPARATION_MANIFEST_FILENAME,
  parsePreparationManifest,
  validatePreparationManifest,
  type PreparationJob,
} from "../src/domain/preparation.ts";
import { nearestShiftToC, nearestSupportedBpm } from "../src/domain/music.ts";
import { TAG_RESERVATION_PATTERN } from "../src/domain/tag-reservation.ts";
import { PreparationQueue } from "../src/library/preparation.ts";
import {
  cents,
  drumLoop,
  measuredFrequency,
  NATURAL,
  noise,
  phrase,
  RATE,
  wavFile,
} from "./audio-signals.ts";
import { BinaryFolder, DirectRunner, gate } from "./preparation-fixtures.ts";

const ANALYSIS = "ravefold-analysis.manifest.json";

async function reply(
  root: BinaryFolder,
  path: string,
): Promise<AudioAnalysisReply> {
  const file = await root.at(path)!.getFile();
  const bytes = await file.arrayBuffer();
  const decoded = await decodeWav(file);
  return {
    sourceSha256: createHash("sha256")
      .update(new Uint8Array(bytes))
      .digest("hex"),
    sourceBytes: bytes.byteLength,
    info: wavInfo(decoded),
    analysis: analyzeAudio(decoded),
    declared: null,
  };
}

function clock(start = 1_800_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out: ${label}`);
}

function job(queue: PreparationQueue, id: string): PreparationJob {
  return queue.getSnapshot().jobs[id]!;
}

async function prepared(root: BinaryFolder, path: string) {
  const runner = new DirectRunner();
  const queue = new PreparationQueue(root, { runner });
  await queue.load();
  const id = await queue.prepare(path, await reply(root, path));
  await queue.whenIdle();
  return { queue, runner, id, job: job(queue, id) };
}

test("tempo and pitch selection use measured values and approved tie rules", () => {
  assert.equal(nearestSupportedBpm(45), 90);
  assert.equal(nearestSupportedBpm(135), 180);
  assert.equal(nearestSupportedBpm(270), 180);
  assert.equal(nearestSupportedBpm(Math.sqrt(90 * 180)), 180);
  assert.equal(nearestSupportedBpm(120), 90);
  assert.deepEqual(
    [1, 2, 3, 5, 6, 7, 9, 11].map(nearestShiftToC),
    [-1, -2, -3, -5, -6, 5, 3, 1],
  );
});

test("S004-AC01: 45, 135 and 270 BPM loops become 90 or 180 BPM with the source beat count", async () => {
  for (const [bpm, target] of [
    [45, 90],
    [135, 180],
    [270, 180],
  ] as const) {
    const root = new BinaryFolder();
    const path = `Loops/c-${bpm}.wav`;
    root.put(path, wavFile(phrase(bpm, NATURAL)));
    const before = root.audio();
    const { job: done } = await prepared(root, path);
    assert.equal(done.phase, "ready", done.message);
    assert.equal(done.plan.targetBpm, target);
    assert.equal(done.plan.beatCount, 8);
    assert.equal(done.plan.semitones, 0);
    assert.equal(
      done.outputPath,
      `RaveFold prepared/Loops/c-${bpm} ${target} BPM.wav`,
    );
    const output = done.output!;
    assert.equal(output.wav.frames, Math.round((8 * 60 * RATE) / target));
    assert.equal(output.analysis.status, "ready");
    assert.equal(output.analysis.measured.bpm, target);
    assert.equal(output.analysis.measured.beatCount, 8);
    const decoded = await decodeWav(await root.at(output.path)!.getFile());
    assert.equal(decoded.frames, output.wav.frames);
    const analysis = parseAudioManifest(root.text(ANALYSIS)!);
    assert.equal(analysis.samples[output.path]?.measured.status, "ready");
    assert.equal(analysis.samples[output.path]?.sourceSha256, output.sha256);
    const after = root.audio();
    for (const [file, hash] of Object.entries(before))
      assert.equal(after[file], hash);
  }
});

test("S004-AC02: a minor phrase in another key meets pitch and duration criteria independently", async () => {
  for (const [bpm, shift, target] of [
    [90, 2, 90],
    [135, 6, 180],
  ] as const) {
    const root = new BinaryFolder();
    const path = `Keys/minor-${bpm}.wav`;
    root.put(
      path,
      wavFile(
        phrase(
          bpm,
          NATURAL.map((note) => note + shift),
        ),
      ),
    );
    const source = await reply(root, path);
    assert.equal(source.analysis.status, "needs-conversion");
    assert.equal(source.analysis.measured.sourceKey?.root, shift);
    const { job: done } = await prepared(root, path);
    assert.equal(done.phase, "ready", done.message);
    assert.equal(done.plan.semitones, -shift);
    // Duration criterion: the exact frame count for eight target beats.
    assert.equal(done.output!.wav.frames, Math.round((8 * 60 * RATE) / target));
    // Pitch criterion: the first sustained note moves from the source root to C4.
    const output = (
      await decodeWav(await root.at(done.output!.path)!.getFile())
    ).channels[0]!;
    const beat = (60 * RATE) / target;
    const measured = measuredFrequency(
      output.subarray(Math.round(beat * 0.15), Math.round(beat * 0.7)),
    );
    const error = cents(measured, 440 * 2 ** ((60 - 69) / 12));
    assert.ok(Math.abs(error) <= 5, `${bpm}: ${error} cents`);
    assert.deepEqual(
      done.output!.analysis.measured.compatibleMinorForms?.includes("natural"),
      true,
    );
  }
});

test("S004-AC03: a key-neutral loop changes tempo without a pitch shift", async () => {
  const root = new BinaryFolder();
  const path = "Drums/hits-135.wav";
  root.put(path, wavFile(drumLoop(135, 8)));
  const { job: done } = await prepared(root, path);
  assert.equal(done.phase, "ready", done.message);
  assert.equal(done.plan.sampleKind, "key-neutral-loop");
  assert.equal(done.plan.semitones, 0);
  assert.equal(done.plan.targetBpm, 180);
  assert.equal(done.output!.measurements.pitchRatio, 1);
  assert.equal(done.output!.analysis.measured.sampleKind, "key-neutral-loop");
  assert.equal(done.output!.analysis.measured.key, undefined);
  assert.equal(done.outputPath, "RaveFold prepared/Drums/hits-135 180 BPM.wav");
});

test("one-shots, ready, major and uncertain material stay out of preparation", async () => {
  const root = new BinaryFolder();
  root.put("one-shot.wav", wavFile(noise(0.6, [0])));
  root.put("ready.wav", wavFile(phrase(90, NATURAL)));
  root.put("major.wav", wavFile(phrase(135, [60, 64, 67, 69, 71, 67, 64, 60])));
  root.put(
    "relative-major.wav",
    wavFile(phrase(90, [60, 62, 64, 65, 67, 69, 71, 60])),
  );
  root.put("quiet.wav", wavFile(new Float32Array(RATE)));
  const queue = new PreparationQueue(root, { runner: new DirectRunner() });
  await queue.load();
  for (const path of [
    "one-shot.wav",
    "ready.wav",
    "major.wav",
    "relative-major.wav",
    "quiet.wav",
  ]) {
    const source = await reply(root, path);
    assert.notEqual(source.analysis.status, "needs-conversion", path);
    assert.equal(planPreparation(source.analysis, source.info).valid, false);
    await assert.rejects(queue.prepare(path, source), Error, path);
  }
  assert.equal(root.text(PREPARATION_MANIFEST_FILENAME), undefined);
});

test("equal source content, region and parameters give one job", async () => {
  const root = new BinaryFolder();
  const bytes = wavFile(phrase(135, NATURAL));
  root.put("a.wav", bytes);
  root.put("copy/a.wav", bytes.slice());
  const runner = new DirectRunner();
  const queue = new PreparationQueue(root, { runner });
  await queue.load();
  const first = await queue.prepare("a.wav", await reply(root, "a.wav"));
  await queue.whenIdle();
  const second = await queue.prepare(
    "copy/a.wav",
    await reply(root, "copy/a.wav"),
  );
  await queue.whenIdle();
  assert.equal(first, second);
  assert.equal(runner.starts, 1);
  assert.equal(Object.keys(queue.getSnapshot().jobs).length, 1);
  const manifest = parsePreparationManifest(
    root.text(PREPARATION_MANIFEST_FILENAME)!,
  );
  assert.equal(manifest.jobs[first]?.phase, "ready");
});

test("S004-AC04: a cancelled conversion and its late result cannot become ready", async () => {
  for (const ignoreAbort of [false, true]) {
    const root = new BinaryFolder();
    const path = "late.wav";
    root.put(path, wavFile(phrase(135, NATURAL)));
    const before = root.audio();
    const runner = new DirectRunner();
    runner.ignoreAbort = ignoreAbort;
    const hold = gate();
    const queue = new PreparationQueue(root, { runner });
    await queue.load();
    runner.holdStage = "conversion";
    runner.gate = hold.promise;
    const id = await queue.prepare(path, await reply(root, path));
    await until(() => job(queue, id).phase === "conversion", "saved phase");
    await queue.cancel(id);
    runner.gate = null;
    hold.open();
    // Cancellation stops the work. A stale reply can still arrive later.
    const late = await runner.late!.catch((error: unknown) => error);
    if (ignoreAbort)
      assert.equal((late as { status?: string }).status, "validated");
    else assert.equal((late as Error).name, "AbortError");
    await queue.whenIdle();
    const saved = parsePreparationManifest(
      root.text(PREPARATION_MANIFEST_FILENAME)!,
    );
    assert.equal(saved.jobs[id]?.phase, "cancelled");
    assert.equal(saved.jobs[id]?.output, null);
    assert.equal(saved.jobs[id]?.lease, null);
    assert.deepEqual(root.audio(), before);
    assert.equal(root.text(ANALYSIS), undefined);
  }
});

test("S004-AC04: cancellation during a write keeps partial audio, and retry uses a new path", async () => {
  const root = new BinaryFolder();
  const path = "write.wav";
  root.put(path, wavFile(phrase(135, NATURAL)));
  const runner = new DirectRunner();
  const queue = new PreparationQueue(root, { runner });
  await queue.load();
  const hold = gate();
  root.disk.holdAudio = hold.promise;
  const id = await queue.prepare(path, await reply(root, path));
  await until(() => job(queue, id).outputPath !== null, "output path");
  const first = job(queue, id).outputPath!;
  await until(() => root.at(first) !== undefined, "created output");
  await queue.cancel(id);
  root.disk.holdAudio = null;
  hold.open();
  await queue.whenIdle();
  assert.equal(job(queue, id).phase, "cancelled");
  const partial = root.at(first)!;
  assert.equal(partial.bytes.byteLength, 0);
  const kept = root.audio();
  await queue.retry(id);
  await queue.whenIdle();
  const done = job(queue, id);
  assert.equal(done.phase, "ready", done.message);
  assert.equal(done.attempt, 2);
  assert.deepEqual(done.keptOutputs, [first]);
  assert.equal(done.outputPath, first.replace(".wav", " (2).wav"));
  assert.equal(root.at(first), partial);
  const after = root.audio();
  for (const [file, hash] of Object.entries(kept))
    assert.equal(after[file], hash);
});

test("S004-AC05: reload after an interrupted write checks inputs and access, then uses a new path", async () => {
  const time = clock();
  const root = new BinaryFolder();
  const path = "Loops/interrupted.wav";
  root.put(path, wavFile(phrase(135, NATURAL)));
  const first = new PreparationQueue(root, {
    runner: new DirectRunner(),
    now: time.now,
  });
  await first.load();
  const hold = gate();
  root.disk.holdAudio = hold.promise;
  const id = await first.prepare(path, await reply(root, path));
  await until(
    () => first.getSnapshot().jobs[id]?.outputPath != null,
    "output path",
  );
  const partialPath = first.getSnapshot().jobs[id]!.outputPath!;
  await until(() => root.at(partialPath) !== undefined, "created output");
  // The tab closes during the write. Some bytes stay in the partial file.
  first.dispose();
  root.disk.holdAudio = null;
  hold.open();
  await first.whenIdle();
  root.at(partialPath)!.bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
  const partialHash = root.audio()[partialPath];
  const interrupted = parsePreparationManifest(
    root.text(PREPARATION_MANIFEST_FILENAME)!,
  );
  assert.equal(interrupted.jobs[id]?.phase, "validation");

  // Access is not available yet. Recovery does not start.
  root.disk.state = "denied";
  const blocked = new PreparationQueue(root, {
    runner: new DirectRunner(),
    now: time.now,
  });
  await blocked.load();
  assert.equal(blocked.getSnapshot().readable, false);
  assert.notEqual(blocked.getSnapshot().message, "");
  root.disk.state = "granted";

  // A live lease from the other session keeps the job with that session.
  const early = new PreparationQueue(root, {
    runner: new DirectRunner(),
    now: time.now,
  });
  await early.load();
  assert.equal(early.getSnapshot().jobs[id]?.phase, "validation");
  early.dispose();

  time.advance(60_000);
  const second = new PreparationQueue(root, {
    runner: new DirectRunner(),
    now: time.now,
  });
  await second.load();
  await second.whenIdle();
  const done = second.getSnapshot().jobs[id]!;
  assert.equal(done.phase, "ready", done.message);
  assert.equal(done.attempt, 2);
  assert.deepEqual(done.keptOutputs, [partialPath]);
  assert.notEqual(done.outputPath, partialPath);
  assert.equal(root.audio()[partialPath], partialHash);
  second.dispose();

  // A changed source fails the input check after recovery.
  const changed = new BinaryFolder();
  changed.put(path, wavFile(phrase(135, NATURAL)));
  const hold2 = gate();
  const runner = new DirectRunner();
  runner.gate = hold2.promise;
  const stalled = new PreparationQueue(changed, { runner, now: time.now });
  await stalled.load();
  const again = await stalled.prepare(path, await reply(changed, path));
  await until(
    () => stalled.getSnapshot().jobs[again]?.phase === "analysis",
    "analysis",
  );
  stalled.dispose();
  hold2.open();
  const source = changed.at(path)!;
  source.bytes = wavFile(
    phrase(
      135,
      NATURAL.map((note) => note + 12),
    ),
  );
  time.advance(60_000);
  const fourth = new PreparationQueue(changed, {
    runner: new DirectRunner(),
    now: time.now,
  });
  await fourth.load();
  await fourth.whenIdle();
  const failed = fourth.getSnapshot().jobs[again]!;
  assert.equal(failed.phase, "failed");
  assert.match(failed.message, /source changed/iu);
  fourth.dispose();
});

test("S004-AC06: insufficient disk space keeps existing audio and lets the user retry", async () => {
  const root = new BinaryFolder();
  const path = "Loops/space.wav";
  root.put(path, wavFile(phrase(135, NATURAL)));
  const occupied = "RaveFold prepared/Loops/space 180 BPM.wav";
  root.put(occupied, wavFile(noise(0.5, [0])));
  const before = root.audio();
  root.disk.failAudio = "QuotaExceededError";
  const queue = new PreparationQueue(root, { runner: new DirectRunner() });
  await queue.load();
  const id = await queue.prepare(path, await reply(root, path));
  await queue.whenIdle();
  const failed = job(queue, id);
  assert.equal(failed.phase, "failed");
  assert.match(failed.message, /insufficient space/iu);
  assert.deepEqual(failed.keptOutputs, [
    "RaveFold prepared/Loops/space 180 BPM (2).wav",
  ]);
  const after = root.audio();
  for (const [file, hash] of Object.entries(before))
    assert.equal(after[file], hash);

  root.disk.failAudio = null;
  await queue.retry(id);
  await queue.whenIdle();
  const done = job(queue, id);
  assert.equal(done.phase, "ready", done.message);
  assert.equal(
    done.outputPath,
    "RaveFold prepared/Loops/space 180 BPM (3).wav",
  );
  assert.equal(root.audio()[occupied], before[occupied]);
});

test("S004-AC07: conversion and retry keep audio in the sample folder and job state in manifests", async () => {
  const root = new BinaryFolder();
  const path = "Loops/writes.wav";
  root.put(path, wavFile(phrase(135, NATURAL)));
  const before = root.audio();
  root.disk.failAudio = "NotReadableError";
  const queue = new PreparationQueue(root, { runner: new DirectRunner() });
  await queue.load();
  const id = await queue.prepare(path, await reply(root, path));
  await queue.whenIdle();
  root.disk.failAudio = null;
  await queue.retry(id);
  await queue.whenIdle();
  assert.equal(job(queue, id).phase, "ready");
  for (const write of root.disk.writes) {
    if (write.kind === "audio")
      assert.match(write.path, /^RaveFold prepared\/Loops\/writes 180 BPM/u);
    else
      assert.ok(
        write.path === PREPARATION_MANIFEST_FILENAME ||
          write.path === ANALYSIS ||
          TAG_RESERVATION_PATTERN.test(write.path),
        write.path,
      );
  }
  for (const removed of root.disk.removals)
    assert.match(removed, TAG_RESERVATION_PATTERN);
  const after = root.audio();
  for (const [file, hash] of Object.entries(before))
    assert.equal(after[file], hash);
  assert.equal(
    Object.keys(after).filter((file) => !(file in before)).length,
    2,
    "one kept partial file and one ready output",
  );
});

test("playback priority holds work between blocks", async () => {
  const root = new BinaryFolder();
  const path = "priority.wav";
  root.put(path, wavFile(phrase(135, NATURAL)));
  const runner = new DirectRunner();
  const queue = new PreparationQueue(root, { runner });
  await queue.load();
  queue.setPlaybackActive(true);
  const id = await queue.prepare(path, await reply(root, path));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.notEqual(job(queue, id).phase, "ready");
  queue.setPlaybackActive(false);
  await queue.whenIdle();
  assert.equal(job(queue, id).phase, "ready");
});

test("two sessions refresh a lost job claim without repeated reservation attempts", async () => {
  const root = new BinaryFolder();
  root.put("shared.wav", wavFile(phrase(135, NATURAL)));
  const original = await prepared(root, "shared.wav");
  original.queue.dispose();
  const queued = {
    ...original.job,
    phase: "queued" as const,
    output: null,
    outputPath: null,
    keptOutputs: [original.job.outputPath!],
  };
  root.put(
    PREPARATION_MANIFEST_FILENAME,
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        jobs: { [queued.id]: queued },
      }),
    ),
  );
  const hold = gate();
  let starts = 0;
  const runner = {
    setPaused() {},
    async run() {
      starts++;
      await hold.promise;
      return { status: "review" as const, reasons: ["Review is necessary."] };
    },
  };
  const first = new PreparationQueue(root, { runner });
  const second = new PreparationQueue(root, { runner });
  let manifestReads = 0;
  let exceeded = false;
  const getFileHandle = root.getFileHandle.bind(root);
  root.getFileHandle = async (name, options) => {
    if (name === PREPARATION_MANIFEST_FILENAME && ++manifestReads > 40) {
      // Bound the regression even when repeated microtasks prevent timers.
      exceeded = true;
      first.dispose();
      second.dispose();
      hold.open();
    }
    return getFileHandle(name, options);
  };
  const refreshed = () => {
    if (
      first.getSnapshot().jobs[queued.id]?.phase === "analysis" &&
      second.getSnapshot().jobs[queued.id]?.phase === "analysis"
    )
      hold.open();
  };
  first.subscribe(refreshed);
  second.subscribe(refreshed);
  try {
    await Promise.all([first.load(), second.load()]);
    await Promise.all([first.whenIdle(), second.whenIdle()]);
    assert.equal(
      exceeded,
      false,
      "A lost claim must refresh the queued snapshot.",
    );
    assert.equal(starts, 1);
    const saved = parsePreparationManifest(
      root.text(PREPARATION_MANIFEST_FILENAME)!,
    );
    assert.equal(saved.jobs[queued.id]?.phase, "review");
  } finally {
    first.dispose();
    second.dispose();
    hold.open();
  }
});

test("a failed completion save stops locally and recovers with a new output path", async () => {
  const root = new BinaryFolder();
  root.put("recovery.wav", wavFile(phrase(135, NATURAL)));
  const queue = new PreparationQueue(root, { runner: new DirectRunner() });
  const hold = gate();
  root.disk.holdAudio = hold.promise;
  try {
    await queue.load();
    const id = await queue.prepare(
      "recovery.wav",
      await reply(root, "recovery.wav"),
    );
    await until(() => job(queue, id).outputPath !== null, "reserved output");
    const firstPath = job(queue, id).outputPath!;
    await until(() => root.at(firstPath) !== undefined, "created output");
    root.disk.failPreparationManifest = "QuotaExceededError";
    root.disk.holdAudio = null;
    hold.open();
    await queue.whenIdle();
    const stopped = queue.getSnapshot();
    assert.equal(stopped.recoveryRequired, true);
    assert.equal(stopped.readable, false);
    assert.match(stopped.message, /insufficient space/u);
    assert.deepEqual(stopped.progress, {});
    assert.equal(
      job(queue, id).phase,
      "validation",
      "Keep the last durable phase.",
    );
    assert.equal(job(queue, id).outputPath, firstPath);
    const keptHash = root.audio()[firstPath];

    await queue.recoverPersistence();
    assert.equal(queue.getSnapshot().recoveryRequired, true);
    assert.equal(job(queue, id).outputPath, firstPath);
    root.disk.failPreparationManifest = null;
    await queue.recoverPersistence();
    await queue.whenIdle();
    const done = job(queue, id);
    assert.equal(queue.getSnapshot().recoveryRequired, false);
    assert.equal(queue.getSnapshot().message, "");
    assert.equal(done.phase, "ready", done.message);
    assert.equal(done.attempt, 2);
    assert.deepEqual(done.keptOutputs, [firstPath]);
    assert.notEqual(done.outputPath, firstPath);
    assert.equal(root.audio()[firstPath], keptHash);
  } finally {
    queue.dispose();
    hold.open();
  }
});

test("a late phase save cannot clear a persistence failure", async () => {
  const root = new BinaryFolder();
  root.put("late-phase.wav", wavFile(phrase(135, NATURAL)));
  const hold = gate();
  const runner = {
    setPaused() {},
    async run(
      _request: Parameters<DirectRunner["run"]>[0],
      { onProgress }: Parameters<DirectRunner["run"]>[1],
    ) {
      const manifest = root.at(PREPARATION_MANIFEST_FILENAME)!;
      const createWritable = manifest.createWritable.bind(manifest);
      manifest.createWritable = async () => {
        manifest.createWritable = createWritable;
        throw new DOMException("Write failed.", "QuotaExceededError");
      };
      onProgress("conversion", 0);
      onProgress("validation", 1);
      await hold.promise;
      return { status: "review" as const, reasons: ["Review is necessary."] };
    },
  };
  const queue = new PreparationQueue(root, { runner });
  try {
    await queue.load();
    const id = await queue.prepare(
      "late-phase.wav",
      await reply(root, "late-phase.wav"),
    );
    await until(
      () => job(queue, id).phase === "validation",
      "successful late phase save",
    );
    hold.open();
    await queue.whenIdle();
    assert.equal(queue.getSnapshot().recoveryRequired, true);
    assert.equal(queue.getSnapshot().readable, false);
    assert.match(queue.getSnapshot().message, /insufficient space/u);
    assert.deepEqual(queue.getSnapshot().progress, {});
    assert.equal(job(queue, id).output, null);
  } finally {
    hold.open();
    queue.dispose();
  }
});

test("strict job records reject unsafe or contradictory state", async () => {
  const root = new BinaryFolder();
  root.put("a.wav", wavFile(phrase(135, NATURAL)));
  const { job: done } = await prepared(root, "a.wav");
  const valid = (jobs: Record<string, unknown>) =>
    validatePreparationManifest({ schemaVersion: 1, revision: 1, jobs });
  assert.doesNotThrow(() => valid({ [done.id]: done }));
  const variants: Array<Partial<PreparationJob> | Record<string, unknown>> = [
    { output: null },
    { phase: "conversion" },
    {
      phase: "queued",
      output: null,
      lease: { session: crypto.randomUUID(), expiresAt: 1 },
    },
    { keptOutputs: [done.outputPath!] },
    { plan: { ...done.plan, outputFrames: done.plan.outputFrames + 1 } },
    {
      plan: {
        ...done.plan,
        sampleKind: "key-neutral-loop",
        semitones: 2,
        expectedPitchClasses: null,
      },
    },
    { processor: "other" },
    {
      output: {
        ...done.output!,
        measurements: { ...done.output!.measurements, peak: 9 },
      },
    },
  ];
  for (const change of variants)
    assert.throws(
      () => valid({ [done.id]: { ...done, ...change } }),
      JSON.stringify(change),
    );
  const copy = { ...done, id: "f".repeat(64) };
  assert.throws(
    () => valid({ [done.id]: done, [copy.id]: copy }),
    /one output path/u,
  );
});
