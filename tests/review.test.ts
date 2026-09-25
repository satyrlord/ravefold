import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeAudio } from "../src/audio/analyze.ts";
import { analyzeRequest } from "../src/audio/analyze-request.ts";
import { decodeWav } from "../src/audio/pcm.ts";
import { wavInfo } from "../src/audio/prepare-core.ts";
import {
  parseAudioManifest,
  validateAudioRecord,
} from "../src/domain/audio-manifest.ts";
import {
  planPreparation,
  PREPARATION_MANIFEST_FILENAME,
  preparationJobId,
  preparedOutputPath,
  validatePreparationPlan,
} from "../src/domain/preparation.ts";
import {
  keyName,
  parseKeyName,
  regionProblem,
  type SourceRegion,
} from "../src/domain/review.ts";
import { TAG_RESERVATION_PATTERN } from "../src/domain/tag-reservation.ts";
import {
  LibraryController,
  type SourceAnalyzer,
} from "../src/library/controller.ts";
import { SourcePreview, type PreviewSpan } from "../src/library/preview.ts";
import { EMPTY_REVIEW, type ReviewInput } from "../src/library/review.ts";
import { NATURAL, noise, phrase, RATE, wavFile } from "./audio-signals.ts";
import { BinaryFolder, DirectRunner, gate } from "./preparation-fixtures.ts";

const ANALYSIS = "ravefold-analysis.manifest.json";
const BEAT_180 = RATE / 3;
/** C minor for four beats, then D major for four beats, at 180 BPM. */
const MIXED_NOTES = [60, 63, 67, 60, 62, 66, 69, 62];
/** A minor notes. The first and last notes do not give the root. */
const RELATIVE_NOTES = [64, 60, 57, 59, 62, 64, 65, 67];
const FIRST_HALF: SourceRegion = {
  startFrame: 0,
  endFrameExclusive: 4 * BEAT_180,
};
const SECOND_HALF: SourceRegion = {
  startFrame: 4 * BEAT_180,
  endFrameExclusive: 8 * BEAT_180,
};

function decoded(audio: Float32Array) {
  return {
    sampleRate: RATE,
    frames: audio.length,
    channels: [audio],
    encoding: "float32" as const,
  };
}

function input(patch: Partial<ReviewInput>): ReviewInput {
  return { ...EMPTY_REVIEW, ...patch };
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 4000; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out: ${label}`);
}

/** Run the Worker request code in this thread. */
function directAnalyzer(): SourceAnalyzer & { calls: number } {
  const analyzer = Object.assign(
    async (...args: Parameters<SourceAnalyzer>) => {
      const [file, signal, officialSource, preparedOutput, review] = args;
      analyzer.calls++;
      signal?.throwIfAborted();
      const bytes = await file.arrayBuffer();
      signal?.throwIfAborted();
      return analyzeRequest({ bytes, officialSource, preparedOutput, review });
    },
    { calls: 0 },
  );
  return analyzer;
}

async function open(root: BinaryFolder, analyze = directAnalyzer()) {
  const runner = new DirectRunner();
  const controller = new LibraryController(root, { runner, analyze });
  await controller.start();
  await until(
    () => controller.getSnapshot().preparation.readable,
    "preparation state",
  );
  return { controller, runner, analyze };
}

function record(root: BinaryFolder, path: string) {
  return parseAudioManifest(root.text(ANALYSIS)!).samples[path];
}

test("key names give roots and modes in both directions", () => {
  assert.deepEqual(parseKeyName("F# minor"), { root: 6, mode: "minor" });
  assert.deepEqual(parseKeyName("Gb minor"), { root: 6, mode: "minor" });
  assert.deepEqual(parseKeyName("Cb major"), { root: 11, mode: "major" });
  assert.equal(parseKeyName("H minor"), null);
  assert.equal(keyName({ root: 3, mode: "minor" }), "Eb minor");
  assert.equal(
    regionProblem(
      { startFrame: 10, endFrameExclusive: 10 },
      {
        frames: 100,
        sampleRate: RATE,
      },
    ),
    "The region is empty.",
  );
  assert.match(
    regionProblem(
      { startFrame: 0, endFrameExclusive: 100 },
      {
        frames: RATE,
        sampleRate: RATE,
      },
    )!,
    /at least/u,
  );
  assert.match(
    regionProblem(
      { startFrame: -1, endFrameExclusive: RATE },
      {
        frames: RATE,
        sampleRate: RATE,
      },
    )!,
    /inside/u,
  );
});

test("a corrected tempo selects only a tempo reading that attacks support", () => {
  const ambiguous = decoded(phrase(180, NATURAL));
  const measured = analyzeAudio(ambiguous);
  assert.equal(measured.status, "needs-review");
  assert.match(measured.reasons[0]!, /both 90 and 180 BPM/u);
  for (const [bpm, beats] of [
    [180, 8],
    [90, 4],
  ] as const) {
    const corrected = analyzeAudio(ambiguous, { correction: { bpm } });
    assert.equal(corrected.status, "ready", JSON.stringify(corrected));
    assert.equal(corrected.measured.bpm, bpm);
    assert.equal(corrected.measured.beatCount, beats);
    assert.match(corrected.reasons.at(-1)!, /correction agrees/u);
  }
  const conflict = analyzeAudio(ambiguous, { correction: { bpm: 120 } });
  assert.equal(conflict.status, "needs-review");
  assert.match(conflict.reasons.at(-1)!, /does not resolve/u);
  const converted = decoded(phrase(135, NATURAL));
  const agrees = analyzeAudio(converted, { correction: { bpm: 135 } });
  assert.equal(agrees.status, "needs-conversion");
  const disagrees = analyzeAudio(converted, { correction: { bpm: 90 } });
  assert.equal(disagrees.status, "needs-review");
  assert.deepEqual(disagrees.reasons, [
    "The corrected tempo does not agree with the measured attacks.",
  ]);
  assert.equal(disagrees.measured.sourceKey, undefined);
  // The corrected value does not replace the measured tempo estimate.
  assert.equal(agrees.measured.estimatedBpm, 135);
});

test("a corrected minor key resolves only a complete minor form", () => {
  const relative = decoded(phrase(90, RELATIVE_NOTES));
  assert.equal(analyzeAudio(relative).status, "needs-review");
  const minor = analyzeAudio(relative, {
    correction: { key: { root: 9, mode: "minor" } },
  });
  assert.equal(minor.status, "needs-conversion", JSON.stringify(minor));
  assert.equal(minor.measured.sourceKey?.root, 9);
  assert.equal(minor.measured.transposeSemitones, 3);
  const major = analyzeAudio(relative, {
    correction: { key: { root: 0, mode: "major" } },
  });
  assert.equal(major.status, "needs-review");
  assert.match(major.reasons[0]!, /Major material stays in review/u);
  const other = analyzeAudio(relative, {
    correction: { key: { root: 2, mode: "minor" } },
  });
  assert.equal(other.status, "needs-review");
  assert.match(other.reasons[0]!, /do not establish the corrected minor key/u);
  // The key of a compatible C-minor phrase cannot move to a major reading.
  const ready = decoded(phrase(90, NATURAL));
  assert.equal(analyzeAudio(ready).status, "ready");
  assert.equal(
    analyzeAudio(ready, { correction: { key: { root: 3, mode: "major" } } })
      .status,
    "needs-review",
  );
  assert.equal(
    analyzeAudio(ready, { correction: { key: { root: 0, mode: "minor" } } })
      .status,
    "ready",
  );
});

test("a tonal class correction that measurements contradict stays in review", () => {
  const beat = 60 / 90;
  const drums = decoded(
    noise(
      beat * 4,
      Array.from({ length: 4 }, (_, index) => index * beat),
    ),
  );
  const neutral = analyzeAudio(drums, { correction: { bpm: 90 } });
  assert.equal(neutral.status, "ready", JSON.stringify(neutral));
  assert.equal(neutral.measured.sampleKind, "key-neutral-loop");
  const tonal = analyzeAudio(drums, {
    correction: { bpm: 90, tonalClass: "tonal" },
  });
  assert.equal(tonal.status, "needs-review");
  assert.deepEqual(tonal.reasons, [
    "No stable notes were measured for the tonal correction.",
  ]);
  const notes = decoded(phrase(90, NATURAL));
  const keyNeutral = analyzeAudio(notes, {
    correction: { tonalClass: "key-neutral" },
  });
  assert.equal(keyNeutral.status, "needs-review");
  assert.equal(keyNeutral.measured.compatiblePitchClasses, undefined);
  const oneShot = decoded(noise(0.6, [0]));
  assert.equal(analyzeAudio(oneShot).status, "ready");
  assert.match(
    analyzeAudio(oneShot, { correction: { bpm: 180 } }).reasons[0]!,
    /one-shot has no source tempo/u,
  );
});

test("records keep corrections apart from measured results and validate regions", async () => {
  const bytes = wavFile(phrase(180, MIXED_NOTES));
  const reply = await analyzeRequest({
    bytes: bytes.slice().buffer,
    review: { region: FIRST_HALF },
  });
  const row = {
    sourceSha256: reply.sourceSha256,
    sourceBytes: reply.sourceBytes,
    wav: reply.info,
    declared: null,
    measured: reply.analysis,
    corrected: { bpm: null, key: null, tonalClass: null, region: FIRST_HALF },
    reviewed: reply.reviewed,
  };
  const valid = validateAudioRecord(row);
  assert.equal(valid.measured.status, "needs-review");
  assert.equal(valid.reviewed?.status, "ready");
  // Records from the earlier slice have no tonal class, region or review.
  assert.deepEqual(
    validateAudioRecord({ ...row, corrected: { bpm: 90, key: "C minor" } })
      .corrected,
    { bpm: 90, key: "C minor" },
  );
  for (const invalid of [
    { ...row, corrected: null },
    {
      ...row,
      corrected: {
        ...row.corrected,
        region: { startFrame: 0, endFrameExclusive: reply.info.frames + 1 },
      },
    },
    {
      ...row,
      corrected: {
        ...row.corrected,
        region: { startFrame: 5, endFrameExclusive: 5 },
      },
    },
    { ...row, corrected: { ...row.corrected, bpm: 1000 } },
    {
      ...row,
      corrected: {
        ...row.corrected,
        tonalClass: "key-neutral",
        key: "C minor",
      },
    },
  ])
    assert.throws(() => validateAudioRecord(invalid));
});

test("section plans keep source coordinates and earlier job IDs", async () => {
  const source = decoded(phrase(180, MIXED_NOTES));
  const info = wavInfo(source);
  const whole = decoded(phrase(135, NATURAL));
  const wholePlan = planPreparation(analyzeAudio(whole), wavInfo(whole));
  assert.equal(wholePlan.valid, true);
  if (!wholePlan.valid) throw new Error("Expected a plan.");
  assert.equal(wholePlan.plan.region, null);
  assert.equal(wholePlan.plan.correction, null);
  // A first-release plan without the new fields validates to the same plan.
  const {
    region: _region,
    correction: _correction,
    ...legacy
  } = wholePlan.plan;
  assert.deepEqual(validatePreparationPlan(legacy), wholePlan.plan);
  const hash = "a".repeat(64);
  assert.equal(
    await preparationJobId(hash, wholePlan.plan),
    await preparationJobId(hash, {
      ...wholePlan.plan,
      region: { startFrame: 0, endFrameExclusive: wholePlan.plan.inputFrames },
    }),
  );
  const first = analyzeAudio(
    decoded(source.channels[0]!.slice(0, FIRST_HALF.endFrameExclusive)),
  );
  const section = planPreparation(first, info, { region: FIRST_HALF });
  assert.equal(section.valid, true, JSON.stringify(section));
  if (!section.valid) throw new Error("Expected a section plan.");
  assert.equal(section.plan.inputFrames, 4 * BEAT_180);
  assert.equal(section.plan.outputFrames, 4 * BEAT_180);
  assert.equal(section.plan.loop, false);
  assert.equal(
    preparedOutputPath("Mixed/mixed.wav", section.plan, 2),
    "RaveFold prepared/Mixed/mixed section 0.000-1.333 s 180 BPM (2).wav",
  );
  const moved = planPreparation(first, info, {
    region: { startFrame: 1, endFrameExclusive: FIRST_HALF.endFrameExclusive },
  });
  assert.equal(moved.valid, true);
  if (!moved.valid) throw new Error("Expected a section plan.");
  assert.notEqual(
    await preparationJobId(hash, section.plan),
    await preparationJobId(hash, moved.plan),
  );
  assert.notEqual(
    await preparationJobId(hash, section.plan),
    await preparationJobId(hash, {
      ...section.plan,
      correction: { bpm: 180, key: null, tonalClass: null },
    }),
  );
  const second = analyzeAudio(
    decoded(source.channels[0]!.slice(SECOND_HALF.startFrame)),
  );
  const held = planPreparation(second, info, { region: SECOND_HALF });
  assert.deepEqual(held, {
    valid: false,
    reason: "This section needs review. It cannot be prepared.",
  });
  assert.deepEqual(
    planPreparation(first, info, {
      region: { startFrame: 100, endFrameExclusive: 100 },
    }),
    { valid: false, reason: "The region is empty." },
  );
  assert.throws(() =>
    validatePreparationPlan({
      ...section.plan,
      region: { startFrame: 0, endFrameExclusive: 10 },
    }),
  );
});

test("S005-AC01: an uncertain sample shows its reason and plays without a status change", async () => {
  const root = new BinaryFolder();
  const path = "Review/ambiguous.wav";
  root.put(path, wavFile(phrase(180, NATURAL)));
  const { controller } = await open(root);
  await controller.select(path);
  const state = controller.getSnapshot();
  assert.equal(state.analysis?.status, "needs-review");
  assert.match(state.analysis!.message, /both 90 and 180 BPM/u);
  assert.equal(state.review, undefined);
  const manifest = root.text(ANALYSIS);
  const writes = root.disk.writes.length;
  const spans: Array<PreviewSpan | undefined> = [];
  const preview = new SourcePreview({
    createAudio: () => ({
      state: "running",
      resume: async () => undefined,
      close: async () => undefined,
      decode: async () => ({
        duration: (8 * BEAT_180) / RATE,
        channels: [new Float32Array(8)],
        start: (_ended, span) => {
          spans.push(span);
          return { stop: () => undefined };
        },
      }),
    }),
  });
  const row = state.catalog.rows.find((sample) => sample.path === path)!;
  await preview.play(row);
  await preview.play(row, { offset: 0, duration: 4 / 3 });
  assert.deepEqual(spans, [undefined, { offset: 0, duration: 4 / 3 }]);
  assert.equal(preview.getState().message, "Section preview is playing.");
  await assert.doesNotReject(async () => preview.dispose());
  assert.equal(controller.getSnapshot().analysis?.status, "needs-review");
  assert.equal(root.text(ANALYSIS), manifest);
  assert.equal(root.disk.writes.length, writes);
  controller.dispose();
});

test("S005-AC02: a corrected tempo is recorded apart from the detector result and validated again", async () => {
  const root = new BinaryFolder();
  const path = "Review/ambiguous.wav";
  root.put(path, wavFile(phrase(180, NATURAL)));
  const { controller, analyze } = await open(root);
  await controller.select(path);
  const calls = analyze.calls;
  await controller.submitReview(input({ bpm: 90 }));
  assert.equal(analyze.calls, calls + 1);
  const state = controller.getSnapshot();
  assert.equal(state.review?.status, "ready", state.review?.message);
  assert.equal(state.analysis?.status, "ready");
  const saved = record(root, path)!;
  assert.equal(saved.measured.status, "needs-review");
  assert.equal(saved.measured.measured.bpm, undefined);
  assert.deepEqual(saved.corrected, {
    bpm: 90,
    key: null,
    tonalClass: null,
    region: null,
  });
  assert.equal(saved.reviewed?.status, "ready");
  assert.equal(saved.reviewed?.measured.bpm, 90);
  assert.equal(saved.reviewed?.measured.beatCount, 4);

  // A conflicting correction stays in review with its reason.
  await controller.submitReview(input({ bpm: 120 }));
  assert.equal(controller.getSnapshot().review?.status, "needs-review");
  assert.equal(controller.getSnapshot().analysis?.status, "needs-review");
  assert.equal(record(root, path)?.corrected?.bpm, 120);

  // A later selection validates the saved correction again.
  await controller.submitReview(input({ bpm: 180 }));
  const before = analyze.calls;
  await controller.select(path);
  assert.equal(analyze.calls, before + 1);
  assert.equal(controller.getSnapshot().review?.input.bpm, 180);
  assert.equal(controller.getSnapshot().analysis?.status, "ready");

  // Out-of-range input goes to no analysis and no write.
  const writes = root.disk.writes.length;
  await controller.submitReview(input({ bpm: 5 }));
  assert.equal(controller.getSnapshot().review?.status, "invalid");
  assert.equal(analyze.calls, before + 1);
  assert.equal(root.disk.writes.length, writes);

  // Empty input removes the correction and restores the detector status.
  await controller.submitReview(EMPTY_REVIEW);
  assert.equal(controller.getSnapshot().review, undefined);
  assert.equal(controller.getSnapshot().analysis?.status, "needs-review");
  assert.equal(record(root, path)?.corrected, null);
  assert.equal(record(root, path)?.reviewed, undefined);
  controller.dispose();
});

test("S005-AC02: a corrected minor key makes a transposition plan from measured notes", async () => {
  const root = new BinaryFolder();
  const path = "Review/relative.wav";
  root.put(path, wavFile(phrase(90, RELATIVE_NOTES)));
  const { controller } = await open(root);
  await controller.select(path);
  assert.equal(controller.getSnapshot().analysis?.status, "needs-review");
  await controller.submitReview(input({ key: "A minor", tonalClass: "tonal" }));
  const state = controller.getSnapshot();
  assert.equal(state.analysis?.status, "needs-conversion");
  assert.equal(state.analysis?.plan?.valid, true);
  await controller.prepare();
  await until(
    () => controller.wholePreparation(path)?.phase === "ready",
    "transposed output",
  );
  const job = controller.wholePreparation(path)!;
  assert.equal(job.plan.semitones, 3);
  assert.deepEqual(job.plan.correction, {
    bpm: null,
    key: "A minor",
    tonalClass: "tonal",
  });
  // Output validation uses measured output notes, not the corrected key.
  assert.equal(job.output?.analysis.status, "ready");
  assert.deepEqual(job.output?.analysis.measured.compatibleMinorForms, [
    "natural",
  ]);
  controller.dispose();
});

test("S005-AC03: only the selected, validated section of mixed-key audio becomes ready", async () => {
  const root = new BinaryFolder();
  const path = "Mixed/mixed.wav";
  const source = phrase(180, MIXED_NOTES);
  root.put(path, wavFile(source));
  const { controller } = await open(root);
  await controller.select(path);
  assert.equal(controller.getSnapshot().analysis?.status, "needs-review");
  await controller.submitReview(input({ region: FIRST_HALF }));
  let state = controller.getSnapshot();
  assert.equal(state.review?.status, "ready", state.review?.message);
  // The section result does not make the source ready.
  assert.equal(state.analysis?.status, "needs-review");
  assert.equal(state.analysis?.plan?.valid, false);
  assert.equal(state.review?.plan?.valid, true);
  await controller.prepareReview();
  await until(
    () => controller.reviewPreparation()?.phase === "ready",
    "section output",
  );
  const job = controller.reviewPreparation()!;
  assert.deepEqual(job.plan.region, FIRST_HALF);
  assert.equal(
    job.output?.path,
    "RaveFold prepared/Mixed/mixed section 0.000-1.333 s 180 BPM.wav",
  );
  assert.equal(job.output?.analysis.status, "ready");
  const output = await decodeWav(await root.at(job.output!.path)!.getFile());
  assert.equal(output.frames, FIRST_HALF.endFrameExclusive);
  assert.deepEqual(
    output.channels[0],
    source.slice(0, FIRST_HALF.endFrameExclusive),
  );
  state = controller.getSnapshot();
  assert.ok(state.catalog.rows.some((row) => row.path === job.output!.path));
  const saved = record(root, path)!;
  assert.equal(saved.measured.status, "needs-review");
  assert.equal(record(root, job.output!.path)?.measured.status, "ready");
  // Selection of the new file finds it ready from its own analysis.
  await controller.select(job.output!.path);
  assert.equal(controller.getSnapshot().analysis?.status, "ready");
  controller.dispose();
});

test("S005-AC03: a corrected tempo section keeps output validation", async () => {
  const root = new BinaryFolder();
  const path = "Review/long.wav";
  root.put(path, wavFile(phrase(180, [...NATURAL, ...NATURAL])));
  const { controller } = await open(root);
  await controller.select(path);
  const region = { startFrame: 0, endFrameExclusive: 8 * BEAT_180 };
  await controller.submitReview(input({ region }));
  assert.equal(controller.getSnapshot().review?.status, "needs-review");
  await controller.submitReview(input({ region, bpm: 90 }));
  assert.equal(controller.getSnapshot().review?.status, "ready");
  await controller.prepareReview();
  await until(
    () => controller.reviewPreparation()?.phase === "ready",
    "corrected section",
  );
  const job = controller.reviewPreparation()!;
  assert.equal(job.plan.targetBpm, 90);
  assert.equal(job.plan.beatCount, 4);
  assert.equal(job.output?.analysis.measured.bpm, 90);
  await controller.select(job.output!.path);
  assert.equal(controller.getSnapshot().analysis?.status, "ready");
  controller.dispose();
});

test("S005-AC04: an incompatible or empty region cannot become ready or replace a derivative", async () => {
  const root = new BinaryFolder();
  const path = "Mixed/mixed.wav";
  root.put(path, wavFile(phrase(180, MIXED_NOTES)));
  const { controller, analyze } = await open(root);
  await controller.select(path);
  await controller.submitReview(input({ region: FIRST_HALF }));
  await controller.prepareReview();
  await until(
    () => controller.reviewPreparation()?.phase === "ready",
    "first section",
  );
  const first = controller.reviewPreparation()!;
  const audio = root.audio();

  await controller.submitReview(input({ region: SECOND_HALF }));
  let state = controller.getSnapshot();
  assert.equal(state.review?.status, "needs-review");
  assert.match(state.review!.message, /C-minor form/u);
  assert.equal(state.review?.plan?.valid, false);
  await controller.prepareReview();
  assert.equal(controller.reviewPreparation(), undefined);

  const calls = analyze.calls;
  for (const region of [
    { startFrame: 1000, endFrameExclusive: 1000 },
    { startFrame: 2000, endFrameExclusive: 1000 },
    { startFrame: 0, endFrameExclusive: 100 },
  ]) {
    await controller.submitReview(input({ region }));
    state = controller.getSnapshot();
    assert.equal(state.review?.status, "invalid");
    await controller.prepareReview();
  }
  assert.equal(analyze.calls, calls);

  // An equal request uses the existing job and writes no new audio.
  await controller.submitReview(input({ region: FIRST_HALF }));
  await controller.prepareReview();
  assert.equal(controller.reviewPreparation()?.id, first.id);
  assert.deepEqual(root.audio(), audio);
  assert.equal(
    Object.keys(controller.getSnapshot().preparation.jobs).length,
    1,
  );
  controller.dispose();
});

test("S005-AC05: a region change during preparation cannot give the late result the new region", async () => {
  const root = new BinaryFolder();
  const path = "Review/c-135.wav";
  root.put(path, wavFile(phrase(135, NATURAL)));
  const { controller, runner } = await open(root);
  const beat = (RATE * 60) / 135;
  const first = { startFrame: 0, endFrameExclusive: Math.round(4 * beat) };
  const second = {
    startFrame: Math.round(4 * beat),
    endFrameExclusive: Math.round(8 * beat),
  };
  await controller.select(path);
  await controller.submitReview(input({ region: first }));
  assert.equal(controller.getSnapshot().review?.status, "needs-conversion");
  const hold = gate();
  runner.gate = hold.promise;
  runner.holdStage = "conversion";
  await controller.prepareReview();
  await until(
    () => controller.reviewPreparation()?.phase === "conversion",
    "active conversion",
  );
  const firstJob = controller.reviewPreparation()!;

  await controller.submitReview(input({ region: second }));
  assert.deepEqual(controller.getSnapshot().review?.input.region, second);
  assert.equal(controller.reviewPreparation(), undefined);
  hold.open();
  await until(
    () =>
      controller.getSnapshot().preparation.jobs[firstJob.id]?.phase === "ready",
    "late first result",
  );
  const late = controller.getSnapshot().preparation.jobs[firstJob.id]!;
  assert.deepEqual(late.plan.region, first);
  assert.match(late.output!.path, / section 0\.000-1\.778 s 180 BPM\.wav$/u);
  assert.equal(controller.reviewPreparation(), undefined);
  assert.deepEqual(controller.getSnapshot().review?.input.region, second);
  const sections = controller.sectionPreparations(
    path,
    late.source.sourceSha256,
  );
  assert.deepEqual(
    sections.map((job) => job.id),
    [firstJob.id],
  );

  runner.gate = null;
  await controller.prepareReview();
  await until(
    () => controller.reviewPreparation()?.phase === "ready",
    "second result",
  );
  const secondJob = controller.reviewPreparation()!;
  assert.notEqual(secondJob.id, firstJob.id);
  assert.deepEqual(secondJob.plan.region, second);
  assert.notEqual(secondJob.output!.path, late.output!.path);
  controller.dispose();
});

test("S005-AC05: a late review analysis cannot replace a newer review input", async () => {
  const root = new BinaryFolder();
  const path = "Mixed/mixed.wav";
  root.put(path, wavFile(phrase(180, MIXED_NOTES)));
  const direct = directAnalyzer();
  const hold = gate();
  const reached = gate();
  let holdNext = false;
  const analyze = Object.assign(
    async (...args: Parameters<SourceAnalyzer>) => {
      if (!holdNext) return direct(...args);
      holdNext = false;
      reached.open();
      await hold.promise;
      // A stale Worker reply arrives after cancellation, as in a slow read.
      const [file, , official, prepared, review] = args;
      return direct(file, undefined, official, prepared, review);
    },
    { calls: 0 },
  );
  const { controller } = await open(root, analyze);
  await controller.select(path);
  holdNext = true;
  const stale = controller.submitReview(input({ region: FIRST_HALF }));
  await reached.promise;
  await controller.submitReview(input({ region: SECOND_HALF }));
  hold.open();
  await stale;
  const state = controller.getSnapshot();
  assert.deepEqual(state.review?.input.region, SECOND_HALF);
  assert.equal(state.review?.status, "needs-review");
  assert.deepEqual(record(root, path)?.corrected?.region, SECOND_HALF);
  controller.dispose();
});

test("S005-AC07: source hashes stay unchanged and new audio stays in the sample folder", async () => {
  const root = new BinaryFolder();
  const paths = ["Mixed/mixed.wav", "Review/relative.wav"];
  root.put(paths[0]!, wavFile(phrase(180, MIXED_NOTES)));
  root.put(paths[1]!, wavFile(phrase(90, RELATIVE_NOTES)));
  const before = root.audio();
  const { controller } = await open(root);
  await controller.select(paths[0]!);
  await controller.submitReview(input({ region: FIRST_HALF }));
  await controller.prepareReview();
  await until(
    () => controller.reviewPreparation()?.phase === "ready",
    "section output",
  );
  await controller.select(paths[1]!);
  await controller.submitReview(input({ key: "A minor" }));
  await controller.prepare();
  await until(
    () => controller.wholePreparation(paths[1]!)?.phase === "ready",
    "transposed output",
  );
  const after = root.audio();
  for (const [path, hash] of Object.entries(before))
    assert.equal(after[path], hash, path);
  const added = Object.keys(after).filter((path) => !(path in before));
  assert.equal(added.length, 2);
  for (const path of added) assert.match(path, /^RaveFold prepared\//u);
  for (const write of root.disk.writes) {
    if (write.kind === "audio")
      assert.match(write.path, /^RaveFold prepared\//u, write.path);
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
  controller.dispose();
});
