import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { WritableHandle } from "../src/storage/handles.ts";
import { validateWav } from "../src/domain/wav.ts";
import {
  AUDIO_MANIFEST_FILENAME,
  emptyAudioManifest,
  readAudioAnalysis,
  saveAudioAnalysis,
  validateAudioRecord,
  validateAudioManifest,
  type AudioAnalysisSave,
} from "../src/library/audio-manifest.ts";
import { SOURCE_MANIFEST_FILENAME } from "../src/domain/source-manifest.ts";
import { LibraryDirectory, LibraryFile } from "./library-fixtures.ts";

function wavBytes(frames = 4): Uint8Array {
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, label: string) => {
    for (let index = 0; index < label.length; index++)
      view.setUint8(offset + index, label.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 4_000, true);
  view.setUint32(28, 8_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, frames * 2, true);
  return bytes;
}

class BinarySource extends LibraryFile {
  bytes: Uint8Array;

  constructor(name: string, bytes = wavBytes()) {
    super(name, "");
    this.bytes = bytes;
  }

  override async getFile(): Promise<File> {
    this.reads++;
    return new File([this.bytes.slice()], this.name);
  }

  override async createWritable(): Promise<WritableHandle> {
    throw new Error("Audio files must not be written.");
  }
}

function source(
  root: LibraryDirectory,
  path: string,
  bytes = wavBytes(),
): BinarySource {
  const parts = path.split("/");
  let folder = root;
  for (const segment of parts.slice(0, -1)) {
    const child = folder.children.get(segment);
    folder = child?.kind === "directory" ? child : folder.folder(segment);
  }
  const file = new BinarySource(parts.at(-1)!, bytes);
  folder.children.set(file.name, file);
  return file;
}

async function result(file: BinarySource): Promise<AudioAnalysisSave> {
  const blob = await file.getFile();
  const wav = await validateWav(blob);
  if (!wav.valid) throw new Error(wav.reason);
  return {
    sourceSha256: createHash("sha256")
      .update(new Uint8Array(await blob.arrayBuffer()))
      .digest("hex"),
    sourceBytes: blob.size,
    info: wav.info,
    analysis: {
      algorithmVersion: "audio-analysis-v2",
      status: "ready",
      measured: {
        sampleKind: "unpitched-one-shot",
        detectorScores: { rhythm: 0.8, pitch: 0.1 },
      },
      reasons: ["Measured unpitched one-shot."],
    },
  };
}

type BackedKind = "source-backed-compatible-loop" | "source-backed-one-shot";

async function backedResult(
  file: BinarySource,
  kind: BackedKind,
): Promise<AudioAnalysisSave> {
  const analyzed = await result(file);
  const gridBeatsAt180 = Math.round(analyzed.info.duration * 3);
  const evidence = {
    gridErrorBeats: Math.abs(analyzed.info.duration * 3 - gridBeatsAt180),
    gridBeatsAt180,
    attackCount: kind === "source-backed-compatible-loop" ? 2 : 1,
    peakRms: 0.1,
    activeSpectralWindows: 3,
    hardConflict: false as const,
    detuned: false as const,
    incompatibleClasses: false as const,
    incompatibleLines: false as const,
  };
  analyzed.declared = {
    source: "og-collection",
    bpm: 180,
    key: "C minor",
  };
  analyzed.analysis = {
    algorithmVersion: "audio-analysis-v2",
    status: "ready",
    measured:
      kind === "source-backed-compatible-loop"
        ? {
            sampleKind: kind,
            bpm: 180,
            beatCount: gridBeatsAt180,
            sourceBackedEvidence: {
              ...evidence,
              envelopeCorrelation180: 0.42,
            },
            detectorScores: { rhythm: 0.42, pitch: 0 },
          }
        : {
            sampleKind: kind,
            sourceBackedEvidence: {
              ...evidence,
              earlyPeakFraction: 0.1,
              decayRatio: 0.1,
            },
            detectorScores: { rhythm: 0, pitch: 0 },
          },
    reasons: ["PCM checks passed with a verified source record."],
  };
  return analyzed;
}

function attest(
  root: LibraryDirectory,
  path: string,
  analyzed: AudioAnalysisSave,
): void {
  root.file(
    SOURCE_MANIFEST_FILENAME,
    JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      sources: {
        [path]: {
          sha256: analyzed.sourceSha256,
          bytes: analyzed.sourceBytes,
          declared: { bpm: 180, key: "C minor" },
          provenance: "user-attested-og",
        },
      },
    }),
  );
}

test("analysis manifest keeps claims apart from measured readiness and does not write audio", async () => {
  const root = new LibraryDirectory();
  const file = source(root, "Drums/hit.wav");
  const before = file.bytes.slice();
  const analyzed = await result(file);
  analyzed.declared = {
    source: "og-collection",
    bpm: 180,
    key: "C minor",
  };
  analyzed.corrected = { bpm: 90, key: "D minor" };
  const first = await saveAudioAnalysis(root, "Drums/hit.wav", analyzed);
  assert.equal(first.revision, 1);
  assert.deepEqual(first.samples["Drums/hit.wav"]?.declared, analyzed.declared);
  assert.deepEqual(
    first.samples["Drums/hit.wav"]?.corrected,
    analyzed.corrected,
  );
  assert.equal(first.samples["Drums/hit.wav"]?.measured.status, "ready");
  assert.equal(
    first.samples["Drums/hit.wav"]?.measured.measured.bpm,
    undefined,
  );
  const manifest = await root.getFileHandle(AUDIO_MANIFEST_FILENAME);
  const writes = manifest.writes;
  const again = await saveAudioAnalysis(root, "Drums/hit.wav", analyzed);
  assert.equal(again.revision, 1);
  assert.equal(manifest.writes, writes);
  const read = await readAudioAnalysis(root);
  assert.equal(read.status, "valid");
  assert.deepEqual(file.bytes, before);
  assert.equal(file.writes, 0);
});

test("strict schema rejects claimed readiness without measured analysis", () => {
  const valid = {
    ...emptyAudioManifest(),
    samples: {
      "hit.wav": {
        sourceSha256: "a".repeat(64),
        sourceBytes: 52,
        wav: {
          encoding: "pcm16",
          channels: 1,
          sampleRate: 4_000,
          frames: 4,
          duration: 0.001,
        },
        declared: { source: "og-collection", bpm: 180, key: "C minor" },
        measured: {
          algorithmVersion: "audio-analysis-v2",
          status: "ready",
          measured: {
            sampleKind: "unpitched-one-shot",
            detectorScores: { rhythm: 0.8, pitch: 0.1 },
          },
          reasons: ["Measured unpitched one-shot."],
        },
        corrected: null,
      },
    },
  };
  assert.deepEqual(validateAudioManifest(valid), valid);
  const row = valid.samples["hit.wav"];
  const reviewed = validateAudioManifest({
    ...valid,
    samples: {
      "hit.wav": {
        ...row,
        measured: {
          ...row.measured,
          status: "needs-review",
          measured: {
            sampleKind: "uncertain",
            detectorScores: { rhythm: 0.1, pitch: 0.1 },
          },
          reasons: ["The source remains uncertain."],
        },
      },
    },
  });
  assert.equal(reviewed.samples["hit.wav"]?.measured.status, "needs-review");
  assert.equal(reviewed.samples["hit.wav"]?.declared?.bpm, 180);
  for (const invalid of [
    { ...valid, schemaVersion: 2 },
    { ...valid, extra: true },
    { ...valid, samples: { "../hit.wav": row } },
    { ...valid, samples: { "hit.wav": { ...row, sourceSha256: "bad" } } },
    { ...valid, samples: { "hit.wav": { ...row, sourceBytes: 0 } } },
    { ...valid, samples: { "hit.wav": { ...row, sourceBytes: 50 } } },
    {
      ...valid,
      samples: { "hit.wav": { ...row, wav: { ...row.wav, channels: 3 } } },
    },
    { ...valid, samples: { "hit.wav": { ...row, measured: null } } },
    {
      ...valid,
      samples: {
        "hit.wav": {
          ...row,
          measured: { ...row.measured, algorithmVersion: "unknown" },
        },
      },
    },
    {
      ...valid,
      samples: {
        "hit.wav": {
          ...row,
          measured: {
            ...row.measured,
            measured: { ...row.measured.measured, bpm: 180 },
          },
        },
      },
    },
    {
      ...valid,
      samples: {
        "hit.wav": {
          ...row,
          measured: {
            ...row.measured,
            measured: { ...row.measured.measured, sampleKind: "uncertain" },
          },
        },
      },
    },
  ])
    assert.throws(() => validateAudioManifest(invalid));
});

test("ready loops use exact supported BPM while retaining a raw estimate", () => {
  const row = {
    sourceSha256: "a".repeat(64),
    sourceBytes: 52,
    wav: {
      encoding: "pcm16",
      channels: 1,
      sampleRate: 4_000,
      frames: 4,
      duration: 0.001,
    },
    declared: { source: "og-collection", bpm: 180, key: "C minor" },
    measured: {
      algorithmVersion: "audio-analysis-v2",
      status: "ready",
      measured: {
        sampleKind: "key-neutral-loop",
        bpm: 90,
        estimatedBpm: 89.6,
        beatCount: 4,
        detectorScores: { rhythm: 0.9, pitch: 0 },
      },
      reasons: ["Measured key-neutral loop."],
    },
    corrected: null,
  };
  assert.equal(
    validateAudioManifest({
      ...emptyAudioManifest(),
      samples: { "loop.wav": row },
    }).samples["loop.wav"]?.measured.measured.estimatedBpm,
    89.6,
  );
  assert.throws(() =>
    validateAudioManifest({
      ...emptyAudioManifest(),
      samples: {
        "loop.wav": {
          ...row,
          measured: {
            ...row.measured,
            measured: { ...row.measured.measured, bpm: 89.6 },
          },
        },
      },
    }),
  );
});

test("measured compatible notes permit a one-note tonal result without an invented key", () => {
  const base = {
    sourceSha256: "a".repeat(64),
    sourceBytes: 52,
    wav: {
      encoding: "pcm16",
      channels: 1,
      sampleRate: 4_000,
      frames: 4,
      duration: 0.001,
    },
    declared: { source: "og-collection", bpm: 180, key: "C minor" },
    measured: {
      algorithmVersion: "audio-analysis-v2",
      status: "ready",
      measured: {
        sampleKind: "tuned-percussion",
        compatiblePitchClasses: [0],
        compatibleMinorForms: ["natural", "harmonic", "melodic"],
        detectorScores: { rhythm: 0, pitch: 0.95 },
      },
      reasons: ["The measured note is compatible with C minor."],
    },
    corrected: null,
  };
  const manifest = (measurements: unknown, version = "audio-analysis-v2") =>
    validateAudioManifest({
      ...emptyAudioManifest(),
      samples: {
        "one-note.wav": {
          ...base,
          measured: {
            ...base.measured,
            algorithmVersion: version,
            measured: measurements,
          },
        },
      },
    });
  const sparse = manifest(base.measured.measured).samples["one-note.wav"]!;
  assert.equal(sparse.measured.status, "ready");
  assert.equal(sparse.measured.measured.key, undefined);
  assert.equal(sparse.measured.measured.minorForm, undefined);
  assert.deepEqual(sparse.measured.measured.compatibleMinorForms, [
    "natural",
    "harmonic",
    "melodic",
  ]);
  assert.equal(sparse.declared?.key, "C minor");

  const loop = manifest({
    ...base.measured.measured,
    sampleKind: "tonal-loop",
    bpm: 90,
    estimatedBpm: 89.6,
  }).samples["one-note.wav"]!;
  assert.equal(loop.measured.measured.bpm, 90);
  assert.equal(loop.measured.measured.key, undefined);

  assert.deepEqual(
    manifest({
      ...base.measured.measured,
      compatiblePitchClasses: [8],
      compatibleMinorForms: ["natural", "harmonic"],
    }).samples["one-note.wav"]?.measured.measured.compatibleMinorForms,
    ["natural", "harmonic"],
  );
  assert.deepEqual(
    manifest({
      ...base.measured.measured,
      compatiblePitchClasses: [9],
      compatibleMinorForms: ["melodic"],
    }).samples["one-note.wav"]?.measured.measured.compatibleMinorForms,
    ["melodic"],
  );

  const fullPhrase = manifest({
    ...base.measured.measured,
    sampleKind: "tonal-loop",
    bpm: 180,
    compatiblePitchClasses: [0, 3, 7, 8, 10],
    compatibleMinorForms: ["natural"],
    key: "C",
    minorForm: "natural",
  }).samples["one-note.wav"]!;
  assert.equal(fullPhrase.measured.measured.minorForm, "natural");

  for (const invalid of [
    { ...base.measured.measured, compatiblePitchClasses: [] },
    { ...base.measured.measured, compatibleMinorForms: [] },
    { ...base.measured.measured, compatiblePitchClasses: [0, 0] },
    { ...base.measured.measured, compatiblePitchClasses: [7, 0] },
    { ...base.measured.measured, compatiblePitchClasses: [12] },
    { ...base.measured.measured, compatiblePitchClasses: [0, 4] },
    { ...base.measured.measured, compatibleMinorForms: ["natural"] },
    { ...base.measured.measured, compatibleMinorForms: undefined },
    { ...base.measured.measured, compatiblePitchClasses: undefined },
    { ...base.measured.measured, key: "C" },
    { ...base.measured.measured, minorForm: "natural" },
    { ...base.measured.measured, detectorScores: { rhythm: 0, pitch: 0 } },
    { ...base.measured.measured, sampleKind: "tonal-loop" },
    { ...base.measured.measured, sampleKind: "unpitched-one-shot" },
    { ...base.measured.measured, sampleKind: "key-neutral-loop", bpm: 90 },
    {
      ...base.measured.measured,
      compatiblePitchClasses: [0, 3, 7, 8, 10],
      compatibleMinorForms: ["natural"],
      key: "C",
      minorForm: "harmonic",
    },
  ])
    assert.throws(() => manifest(invalid));
  assert.throws(() => manifest(base.measured.measured, "audio-analysis-v1"));
});

test("a changed source or false WAV description cannot receive a saved analysis", async () => {
  const root = new LibraryDirectory();
  const file = source(root, "hit.wav");
  const analyzed = await result(file);
  file.bytes[44] = 1;
  await assert.rejects(
    saveAudioAnalysis(root, "hit.wav", analyzed),
    /changed/u,
  );
  assert.equal((await readAudioAnalysis(root)).status, "missing");
  assert.equal(file.writes, 0);
  const fresh = await result(file);
  fresh.info = { ...fresh.info, sampleRate: 8_000, duration: 4 / 8_000 };
  await assert.rejects(saveAudioAnalysis(root, "hit.wav", fresh));
  assert.equal((await readAudioAnalysis(root)).status, "missing");
});

test("malformed or unsupported existing analysis remains unchanged", async () => {
  for (const text of [
    "not JSON",
    JSON.stringify({ ...emptyAudioManifest(), schemaVersion: 2 }),
  ]) {
    const root = new LibraryDirectory();
    const audio = source(root, "hit.wav");
    const manifest = root.file(AUDIO_MANIFEST_FILENAME, text);
    assert.equal((await readAudioAnalysis(root)).status, "invalid");
    await assert.rejects(
      saveAudioAnalysis(root, "hit.wav", await result(audio)),
    );
    assert.equal(manifest.contents, text);
    assert.equal(manifest.writes, 0);
    assert.equal(audio.writes, 0);
  }
});

test("failed and conflicting saves keep the last complete manifest", async () => {
  const root = new LibraryDirectory();
  const audio = source(root, "hit.wav");
  const analyzed = await result(audio);
  await saveAudioAnalysis(root, "hit.wav", analyzed);
  const handle = await root.getFileHandle(AUDIO_MANIFEST_FILENAME);
  const previous = handle.contents;
  handle.failClose = true;
  await assert.rejects(
    saveAudioAnalysis(root, "hit.wav", {
      ...analyzed,
      corrected: { bpm: 90, key: "C minor" },
    }),
  );
  assert.equal(handle.contents, previous);
  assert.equal(handle.active, 0);
  handle.failClose = false;
  const external = JSON.stringify({
    schemaVersion: 1,
    revision: 2,
    samples: {
      "hit.wav": {
        ...JSON.parse(previous).samples["hit.wav"],
        corrected: { bpm: 180, key: "C minor" },
      },
    },
  });
  handle.onWrite = () => {
    handle.contents = external;
  };
  await assert.rejects(
    saveAudioAnalysis(root, "hit.wav", {
      ...analyzed,
      corrected: { bpm: 90, key: "C minor" },
    }),
    /another session/u,
  );
  assert.equal(handle.contents, external);
  assert.equal(audio.writes, 0);
});

test("independent sample edits merge and competing edits to one sample conflict", async () => {
  const root = new LibraryDirectory();
  const first = source(root, "First/hit.wav");
  const second = source(root, "Second/hit.wav");
  const a = await result(first);
  const b = await result(second);
  await Promise.all([
    saveAudioAnalysis(root, "First/hit.wav", a),
    saveAudioAnalysis(root, "Second/hit.wav", b),
  ]);
  const read = await readAudioAnalysis(root);
  assert.equal(read.status, "valid");
  if (read.status !== "valid") throw new Error("Expected saved analysis.");
  assert.equal(read.value.revision, 2);
  assert.equal(Object.keys(read.value.samples).length, 2);
  const attempts = await Promise.allSettled([
    saveAudioAnalysis(root, "First/hit.wav", {
      ...a,
      corrected: { bpm: 90, key: "C minor" },
    }),
    saveAudioAnalysis(root, "First/hit.wav", {
      ...a,
      corrected: { bpm: 180, key: "C minor" },
    }),
  ]);
  assert.deepEqual(
    attempts.map((item) => item.status),
    ["fulfilled", "rejected"],
  );
  assert.equal(first.writes + second.writes, 0);
});

test("source-backed loops and one-shots save separate PCM and declaration evidence", async () => {
  for (const [kind, frames] of [
    ["source-backed-compatible-loop", Math.round((4 * 4_000) / 3)],
    ["source-backed-one-shot", Math.round(4_000 / 3)],
  ] as const) {
    const root = new LibraryDirectory();
    const path = "OG/source.wav";
    const file = source(root, path, wavBytes(frames));
    const before = file.bytes.slice();
    const analyzed = await backedResult(file, kind);
    attest(root, path, analyzed);
    const saved = await saveAudioAnalysis(root, path, analyzed);
    const row = saved.samples[path]!;
    assert.equal(row.measured.status, "ready");
    assert.equal(row.measured.measured.sampleKind, kind);
    assert.equal(row.measured.measured.key, undefined);
    assert.equal(row.measured.measured.minorForm, undefined);
    assert.equal(row.measured.measured.estimatedBpm, undefined);
    assert.equal(row.declared?.key, "C minor");
    assert.equal(
      row.measured.measured.bpm,
      kind === "source-backed-compatible-loop" ? 180 : undefined,
    );
    assert.deepEqual(file.bytes, before);
    assert.equal(file.writes, 0);
  }
});

test("source-backed schema rejects invented notes, false gates and false declarations", async () => {
  const root = new LibraryDirectory();
  const file = source(
    root,
    "OG/loop.wav",
    wavBytes(Math.round((4 * 4_000) / 3)),
  );
  const analyzed = await backedResult(file, "source-backed-compatible-loop");
  const row = {
    sourceSha256: analyzed.sourceSha256,
    sourceBytes: analyzed.sourceBytes,
    wav: analyzed.info,
    declared: analyzed.declared,
    measured: analyzed.analysis,
    corrected: null,
  };
  assert.equal(validateAudioRecord(row).measured.status, "ready");
  const evidence = analyzed.analysis.measured.sourceBackedEvidence!;
  const measurements = analyzed.analysis.measured;
  const invalidMeasurements = [
    { ...measurements, sourceBackedEvidence: undefined },
    {
      ...measurements,
      sourceBackedEvidence: { ...evidence, gridErrorBeats: 0.02 },
    },
    {
      ...measurements,
      sourceBackedEvidence: { ...evidence, gridBeatsAt180: 5 },
    },
    { ...measurements, sourceBackedEvidence: { ...evidence, attackCount: 1 } },
    { ...measurements, sourceBackedEvidence: { ...evidence, peakRms: 0.001 } },
    {
      ...measurements,
      sourceBackedEvidence: { ...evidence, activeSpectralWindows: 1 },
    },
    {
      ...measurements,
      sourceBackedEvidence: { ...evidence, hardConflict: true },
    },
    { ...measurements, sourceBackedEvidence: { ...evidence, detuned: true } },
    {
      ...measurements,
      sourceBackedEvidence: { ...evidence, incompatibleClasses: true },
    },
    {
      ...measurements,
      sourceBackedEvidence: { ...evidence, incompatibleLines: true },
    },
    {
      ...measurements,
      sourceBackedEvidence: { ...evidence, envelopeCorrelation180: 0.14 },
    },
    {
      ...measurements,
      sourceBackedEvidence: { ...evidence, earlyPeakFraction: 0.1 },
    },
    { ...measurements, bpm: 90 },
    { ...measurements, beatCount: 5 },
    { ...measurements, estimatedBpm: 180 },
    { ...measurements, key: "C" },
    {
      ...measurements,
      compatiblePitchClasses: [0],
      compatibleMinorForms: ["natural", "harmonic", "melodic"],
    },
    { ...measurements, detectorScores: { rhythm: 0.42, pitch: 0.2 } },
  ];
  for (const invalid of invalidMeasurements)
    assert.throws(() =>
      validateAudioRecord({
        ...row,
        measured: { ...analyzed.analysis, measured: invalid },
      }),
    );
  for (const declared of [null, { source: "user", bpm: 180, key: "C minor" }])
    assert.throws(() => validateAudioRecord({ ...row, declared }));
  assert.throws(() =>
    validateAudioRecord({
      ...row,
      wav: {
        ...row.wav,
        loop: { startFrame: 1, endFrameExclusive: row.wav.frames },
      },
    }),
  );
});

test("source-backed one-shot schema requires measured early decay and no tempo", async () => {
  const root = new LibraryDirectory();
  const file = source(root, "OG/shot.wav", wavBytes(Math.round(4_000 / 3)));
  const analyzed = await backedResult(file, "source-backed-one-shot");
  const row = {
    sourceSha256: analyzed.sourceSha256,
    sourceBytes: analyzed.sourceBytes,
    wav: analyzed.info,
    declared: analyzed.declared,
    measured: analyzed.analysis,
    corrected: null,
  };
  assert.equal(validateAudioRecord(row).measured.status, "ready");
  const evidence = analyzed.analysis.measured.sourceBackedEvidence!;
  const measurements = analyzed.analysis.measured;
  for (const invalid of [
    { ...measurements, bpm: 180 },
    { ...measurements, beatCount: 1 },
    { ...measurements, sourceBackedEvidence: { ...evidence, attackCount: 0 } },
    { ...measurements, sourceBackedEvidence: { ...evidence, attackCount: 4 } },
    {
      ...measurements,
      sourceBackedEvidence: { ...evidence, earlyPeakFraction: 0.4 },
    },
    { ...measurements, sourceBackedEvidence: { ...evidence, decayRatio: 0.3 } },
    {
      ...measurements,
      sourceBackedEvidence: { ...evidence, envelopeCorrelation180: 0.2 },
    },
  ])
    assert.throws(() =>
      validateAudioRecord({
        ...row,
        measured: { ...analyzed.analysis, measured: invalid },
      }),
    );
});

test("source-backed writes fail closed without a current source manifest", async () => {
  const root = new LibraryDirectory();
  const path = "OG/loop.wav";
  const file = source(root, path, wavBytes(Math.round((4 * 4_000) / 3)));
  const analyzed = await backedResult(file, "source-backed-compatible-loop");
  await assert.rejects(
    saveAudioAnalysis(root, path, analyzed),
    /source record/u,
  );
  assert.equal((await readAudioAnalysis(root)).status, "missing");
  attest(root, path, analyzed);
  const sourceManifest = await root.getFileHandle(SOURCE_MANIFEST_FILENAME);
  const validSourceText = sourceManifest.contents;
  sourceManifest.contents = validSourceText.replace(
    analyzed.sourceSha256,
    "a".repeat(64),
  );
  await assert.rejects(
    saveAudioAnalysis(root, path, analyzed),
    /source record/u,
  );
  assert.equal((await readAudioAnalysis(root)).status, "missing");
  sourceManifest.contents = "not JSON";
  await assert.rejects(
    saveAudioAnalysis(root, path, analyzed),
    /source record/u,
  );
  assert.equal((await readAudioAnalysis(root)).status, "missing");
  sourceManifest.contents = validSourceText;
  await saveAudioAnalysis(root, path, analyzed);
  const analysisManifest = await root.getFileHandle(AUDIO_MANIFEST_FILENAME);
  const writes = analysisManifest.writes;
  sourceManifest.contents = "not JSON";
  await assert.rejects(
    saveAudioAnalysis(root, path, analyzed),
    /source record/u,
  );
  assert.equal(analysisManifest.writes, writes);
  assert.equal((await readAudioAnalysis(root)).status, "valid");
  assert.equal(file.writes, 0);
});
