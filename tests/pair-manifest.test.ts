import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { analyzeAudio } from "../src/audio/analyze.ts";
import { decodeWav } from "../src/audio/pcm.ts";
import { validateStereoPair } from "../src/domain/stereo-pair.ts";
import { validateWav } from "../src/domain/wav.ts";
import {
  emptyPairManifest,
  PAIR_MANIFEST_FILENAME,
  pairId,
  readPairAnalysis,
  savePairAnalysis,
  validatePairManifest,
  type PairAnalysisSave,
} from "../src/library/pair-manifest.ts";
import type { WritableHandle } from "../src/storage/handles.ts";
import { LibraryDirectory, LibraryFile } from "./library-fixtures.ts";

function pulseWav(seedValue: number, gain = 1): Uint8Array<ArrayBuffer> {
  const sampleRate = 48_000;
  const frames = 128_000;
  const bytes = new Uint8Array(44 + frames * 2);
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
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, frames * 2, true);
  let seed = seedValue;
  for (let beat = 0; beat < 4; beat++) {
    for (const start of [beat * 32_000, beat * 32_000 + 8_000]) {
      for (let frame = 0; frame < 12_000; frame++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        const random = (seed >>> 0) / 0xffffffff;
        const envelope = Math.exp((-10 * frame) / 12_000);
        const value = Math.round(
          (random * 2 - 1) * envelope * 0.8 * gain * 32767,
        );
        view.setInt16(44 + (start + frame) * 2, value, true);
      }
    }
  }
  return bytes;
}

class BinarySource extends LibraryFile {
  bytes: Uint8Array<ArrayBuffer>;

  constructor(name: string, bytes: Uint8Array<ArrayBuffer>) {
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
  seed: number,
  gain = 1,
): BinarySource {
  const parts = path.split("/");
  let folder = root;
  for (const part of parts.slice(0, -1)) {
    const child = folder.children.get(part);
    folder = child?.kind === "directory" ? child : folder.folder(part);
  }
  const file = new BinarySource(parts.at(-1)!, pulseWav(seed, gain));
  folder.children.set(file.name, file);
  return file;
}

async function analyzedPair(
  left: BinarySource,
  right: BinarySource,
  leftPath = "Parts/left.wav",
  rightPath = "Parts/right.wav",
): Promise<PairAnalysisSave> {
  const leftFile = await left.getFile();
  const rightFile = await right.getFile();
  const leftWav = await validateWav(leftFile);
  const rightWav = await validateWav(rightFile);
  if (!leftWav.valid || !rightWav.valid)
    throw new Error("Invalid fixture WAV.");
  const leftHash = createHash("sha256")
    .update(new Uint8Array(await leftFile.arrayBuffer()))
    .digest("hex");
  const rightHash = createHash("sha256")
    .update(new Uint8Array(await rightFile.arrayBuffer()))
    .digest("hex");
  const provenance = { kind: "user-selected" as const, id: randomUUID() };
  const measured = await validateStereoPair(
    { path: leftPath, file: leftFile },
    { path: rightPath, file: rightFile },
    {
      provenanceId: provenance.id,
      channelOrder: "left-right",
      frameOffset: 0,
      left: { path: leftPath, sha256: leftHash },
      right: { path: rightPath, sha256: rightHash },
    },
  );
  if (!measured.valid) throw new Error(measured.reason);
  const leftAudio = await decodeWav(leftFile);
  const rightAudio = await decodeWav(rightFile);
  const analysis = analyzeAudio({
    sampleRate: leftAudio.sampleRate,
    frames: leftAudio.frames,
    channels: [leftAudio.channels[0]!, rightAudio.channels[0]!],
    encoding: leftAudio.encoding,
  });
  return {
    left: {
      path: leftPath,
      sourceBytes: leftFile.size,
      sourceSha256: leftHash,
      wav: leftWav.info,
    },
    right: {
      path: rightPath,
      sourceBytes: rightFile.size,
      sourceSha256: rightHash,
      wav: rightWav.info,
    },
    provenance,
    alignment: measured,
    analysis,
  };
}

test("save a measured ready pair without writing source audio", async () => {
  const root = new LibraryDirectory();
  const left = source(root, "Parts/left.wav", 17);
  const right = source(root, "Parts/right.wav", 17, 0.8);
  const leftBefore = left.bytes.slice();
  const rightBefore = right.bytes.slice();
  const input = await analyzedPair(left, right);
  assert.equal(input.analysis.status, "ready", JSON.stringify(input.analysis));
  const id = await pairId(input.left.path, input.right.path);
  const first = await savePairAnalysis(root, input);
  assert.equal(first.revision, 1);
  assert.equal(first.pairs[id]?.id, id);
  assert.equal(first.pairs[id]?.analysis.status, "ready");
  assert.equal(first.pairs[id]?.provenance.id, input.provenance.id);
  assert.equal(first.pairs[id]?.left.sourceSha256, input.left.sourceSha256);
  assert.equal(first.pairs[id]?.right.sourceSha256, input.right.sourceSha256);
  const manifest = await root.getFileHandle(PAIR_MANIFEST_FILENAME);
  const writes = manifest.writes;
  const again = await savePairAnalysis(root, input);
  assert.equal(again.revision, 1);
  assert.equal(manifest.writes, writes);
  assert.equal((await readPairAnalysis(root)).status, "valid");
  assert.deepEqual(left.bytes, leftBefore);
  assert.deepEqual(right.bytes, rightBefore);
  assert.equal(left.writes + right.writes, 0);
});

test("a pair cannot inherit source-backed readiness from one source", async () => {
  const root = new LibraryDirectory();
  const left = source(root, "Parts/left.wav", 17);
  const right = source(root, "Parts/right.wav", 17, 0.8);
  const input = await analyzedPair(left, right);
  input.analysis = {
    algorithmVersion: "audio-analysis-v2",
    status: "ready",
    measured: {
      sampleKind: "source-backed-compatible-loop",
      bpm: 180,
      beatCount: 8,
      sourceBackedEvidence: {
        gridErrorBeats: 0,
        gridBeatsAt180: 8,
        attackCount: 4,
        peakRms: 0.1,
        activeSpectralWindows: 3,
        hardConflict: false,
        detuned: false,
        incompatibleClasses: false,
        incompatibleLines: false,
        envelopeCorrelation180: 0.2,
      },
      detectorScores: { rhythm: 0.2, pitch: 0 },
    },
    reasons: ["One source has an OG declaration."],
  };
  await assert.rejects(
    savePairAnalysis(root, input),
    /separate OG declaration/u,
  );
  assert.equal((await readPairAnalysis(root)).status, "missing");
  assert.equal(left.writes + right.writes, 0);
});

test("ordered source paths give distinct stable pair IDs", async () => {
  const left = await pairId("Parts/left.wav", "Parts/right.wav");
  assert.equal(left, await pairId("Parts/left.wav", "Parts/right.wav"));
  assert.notEqual(left, await pairId("Parts/right.wav", "Parts/left.wav"));
});

test("reject changed source bytes and false pair evidence before a ready write", async () => {
  const root = new LibraryDirectory();
  const left = source(root, "Parts/left.wav", 17);
  const right = source(root, "Parts/right.wav", 93);
  const input = await analyzedPair(left, right);
  const falseInputs: PairAnalysisSave[] = [
    {
      ...input,
      alignment: {
        ...input.alignment,
        info: {
          ...input.alignment.info,
          left: { ...input.alignment.info.left, path: "Parts/other.wav" },
        },
      },
    },
    {
      ...input,
      alignment: {
        ...input.alignment,
        info: {
          ...input.alignment.info,
          provenanceId: randomUUID(),
        },
      },
    },
    {
      ...input,
      alignment: {
        ...input.alignment,
        info: {
          ...input.alignment.info,
          frames: input.alignment.info.frames + 1,
        },
      },
    },
  ];
  for (const falseInput of falseInputs)
    await assert.rejects(savePairAnalysis(root, falseInput));
  assert.equal((await readPairAnalysis(root)).status, "missing");
  left.bytes[44] ^= 1;
  await assert.rejects(savePairAnalysis(root, input), /changed/u);
  assert.equal((await readPairAnalysis(root)).status, "missing");
  assert.equal(left.writes + right.writes, 0);
});

test("a source change during a manifest write cannot commit readiness", async () => {
  const root = new LibraryDirectory();
  const left = source(root, "Parts/left.wav", 17);
  const right = source(root, "Parts/right.wav", 17, 0.8);
  const input = await analyzedPair(left, right);
  assert.equal(input.analysis.status, "ready");
  root.onCreate = (file) => {
    if (file.name === PAIR_MANIFEST_FILENAME)
      file.onWrite = () => {
        left.bytes[44] ^= 1;
      };
  };
  await assert.rejects(savePairAnalysis(root, input), /changed/u);
  assert.equal((await readPairAnalysis(root)).status, "missing");
  assert.equal(left.writes + right.writes, 0);
});

test("non-ready stereo analysis stays non-ready with its measured reason", async () => {
  const root = new LibraryDirectory();
  const left = source(root, "Parts/left.wav", 17);
  const right = source(root, "Parts/right.wav", 93);
  const input = await analyzedPair(left, right);
  const reviewed: PairAnalysisSave = {
    ...input,
    analysis: {
      ...input.analysis,
      status: "needs-review",
      reasons: ["The combined channel result needs review."],
    },
  };
  const saved = await savePairAnalysis(root, reviewed);
  const id = await pairId(input.left.path, input.right.path);
  assert.equal(saved.pairs[id]?.analysis.status, "needs-review");
  assert.deepEqual(
    saved.pairs[id]?.analysis.reasons,
    reviewed.analysis.reasons,
  );
});

test("malformed and incorrectly keyed manifests remain unchanged", async () => {
  for (const text of [
    "not JSON",
    JSON.stringify({ ...emptyPairManifest(), schemaVersion: 2 }),
  ]) {
    const root = new LibraryDirectory();
    const left = source(root, "Parts/left.wav", 17);
    const right = source(root, "Parts/right.wav", 93);
    const file = root.file(PAIR_MANIFEST_FILENAME, text);
    assert.equal((await readPairAnalysis(root)).status, "invalid");
    await assert.rejects(
      savePairAnalysis(root, await analyzedPair(left, right)),
    );
    assert.equal(file.contents, text);
    assert.equal(file.writes, 0);
  }
  const root = new LibraryDirectory();
  const left = source(root, "Parts/left.wav", 17);
  const right = source(root, "Parts/right.wav", 93);
  const input = await analyzedPair(left, right);
  const saved = await savePairAnalysis(root, input);
  const row = Object.values(saved.pairs)[0]!;
  const wrong = {
    ...saved,
    pairs: { ["f".repeat(64)]: { ...row, id: "f".repeat(64) } },
  };
  assert.deepEqual(validatePairManifest(wrong), wrong);
  root.file(PAIR_MANIFEST_FILENAME, JSON.stringify(wrong));
  assert.equal((await readPairAnalysis(root)).status, "invalid");
});

test("a failed manifest close preserves the last complete pair record", async () => {
  const root = new LibraryDirectory();
  const left = source(root, "Parts/left.wav", 17);
  const right = source(root, "Parts/right.wav", 93);
  const input = await analyzedPair(left, right);
  await savePairAnalysis(root, input);
  const file = await root.getFileHandle(PAIR_MANIFEST_FILENAME);
  const previous = file.contents;
  file.failClose = true;
  await assert.rejects(
    savePairAnalysis(root, {
      ...input,
      analysis: {
        ...input.analysis,
        status: "needs-review",
        reasons: ["The pair needs another review."],
      },
    }),
  );
  assert.equal(file.contents, previous);
  assert.equal(file.active, 0);
  assert.equal(left.writes + right.writes, 0);
});
