import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { analyzeAudio } from "../src/audio/analyze.ts";
import { decodeWav } from "../src/audio/pcm.ts";
import type { DeclaredAudio } from "../src/domain/audio-manifest.ts";
import { validateWav } from "../src/domain/wav.ts";
import {
  readAudioAnalysis,
  saveAudioAnalysis,
} from "../src/library/audio-manifest.ts";
import type { WritableHandle } from "../src/storage/handles.ts";
import { LibraryDirectory, LibraryFile } from "./library-fixtures.ts";

const RATE = 48_000;
const NATURAL = [60, 63, 67, 68, 70, 67, 63, 60];
const HARMONIC = [60, 63, 67, 68, 71, 67, 63, 60];
const MELODIC = [60, 63, 67, 69, 71, 67, 63, 60];
const MAJOR = [60, 64, 67, 69, 71, 67, 64, 60];
const MIXED = [60, 63, 67, 64, 68, 70, 63, 60];

type Outcome = "ready" | "needs-review" | "needs-conversion" | "unusable";

interface LabeledCase {
  path: string;
  label: string;
  bytes: Uint8Array;
  expected: Outcome;
  declared: DeclaredAudio | null;
}

class BinarySource extends LibraryFile {
  bytes: Uint8Array;

  constructor(name: string, bytes: Uint8Array) {
    super(name, "");
    this.bytes = bytes;
  }

  override async getFile(): Promise<File> {
    this.reads++;
    return new File([this.bytes.slice()], this.name);
  }

  override async createWritable(): Promise<WritableHandle> {
    throw new Error("Source audio must not be written.");
  }
}

function phrase(
  bpm: number,
  notes: readonly number[],
  tuned = false,
): Float32Array {
  const phraseNotes =
    bpm === 180 ? [...notes.slice(0, 5), notes.at(-1)!] : notes;
  const beatFrames = (RATE * 60) / bpm;
  const audio = new Float32Array(Math.round(phraseNotes.length * beatFrames));
  for (let beat = 0; beat < phraseNotes.length; beat++) {
    const start = Math.round(beat * beatFrames);
    const end = Math.round((beat + 1) * beatFrames);
    const active = Math.floor((end - start) * 0.82);
    const frequency = 440 * 2 ** ((phraseNotes[beat]! - 69) / 12);
    for (let frame = 0; frame < active; frame++) {
      const seconds = frame / RATE;
      const attack = Math.min(1, seconds / 0.006);
      const envelope = tuned ? Math.exp((-7 * frame) / (end - start)) : 1;
      const accent = bpm === 180 && beat % 4 === 0 ? 1.6 : 1;
      audio[start + frame] =
        0.45 *
        accent *
        attack *
        envelope *
        Math.sin(2 * Math.PI * frequency * seconds);
    }
  }
  return audio;
}

function noise(seconds: number, pulses: readonly number[]): Float32Array {
  const audio = new Float32Array(Math.round(seconds * RATE));
  let seed = 0x5a17;
  for (const pulse of pulses) {
    const start = Math.round(pulse * RATE);
    const active = Math.min(Math.round(RATE * 0.25), audio.length - start);
    for (let frame = 0; frame < active; frame++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const random = (seed >>> 0) / 0xffffffff;
      const envelope = Math.exp((-10 * frame) / active);
      audio[start + frame] = (random * 2 - 1) * envelope * 0.8;
    }
  }
  return audio;
}

function wav(audio: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + audio.length * 4);
  const view = new DataView(bytes.buffer);
  const mark = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++)
      view.setUint8(offset + index, text.charCodeAt(index));
  };
  mark(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  mark(8, "WAVE");
  mark(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  mark(36, "data");
  view.setUint32(40, audio.length * 4, true);
  for (let frame = 0; frame < audio.length; frame++)
    view.setFloat32(44 + frame * 4, audio[frame]!, true);
  return bytes;
}

function corpus(): LabeledCase[] {
  const official: DeclaredAudio = {
    source: "og-collection",
    bpm: 180,
    key: "C minor",
  };
  const beat90 = 60 / 90;
  const drumPulses = Array.from({ length: 4 }, (_, index) => [
    index * beat90,
    index * beat90 + beat90 / 4,
  ]).flat();
  const invalidChannels = wav(noise(0.6, [0]));
  new DataView(invalidChannels.buffer).setUint16(22, 3, true);
  const nonfinite = wav(noise(0.6, [0]));
  new DataView(nonfinite.buffer).setFloat32(44, Number.NaN, true);
  const truncated = wav(noise(0.6, [0])).slice(0, -1);
  return [
    {
      path: "tonal-natural.wav",
      label: "C natural minor at 180 BPM",
      bytes: wav(phrase(180, NATURAL)),
      expected: "ready",
      declared: official,
    },
    {
      path: "tonal-harmonic.wav",
      label: "C harmonic minor at 90 BPM",
      bytes: wav(phrase(90, HARMONIC)),
      expected: "ready",
      declared: null,
    },
    {
      path: "tonal-melodic.wav",
      label: "C melodic minor at 180 BPM",
      bytes: wav(phrase(180, MELODIC)),
      expected: "ready",
      declared: null,
    },
    {
      path: "unpitched-one-shot.wav",
      label: "Unpitched one-shot without declared tempo or key",
      bytes: wav(noise(0.6, [0])),
      expected: "ready",
      declared: null,
    },
    {
      path: "drum-loop.wav",
      label: "Key-neutral 90 BPM drum loop",
      bytes: wav(noise(beat90 * 4, drumPulses)),
      expected: "ready",
      declared: official,
    },
    {
      path: "tuned-percussion.wav",
      label: "C harmonic minor tuned percussion",
      bytes: wav(phrase(180, HARMONIC, true)),
      expected: "ready",
      declared: null,
    },
    {
      path: "major.wav",
      label: "Major phrase with a false C-minor declaration",
      bytes: wav(phrase(180, MAJOR)),
      expected: "needs-review",
      declared: official,
    },
    {
      path: "mixed.wav",
      label: "Mixed-key phrase with a false C-minor declaration",
      bytes: wav(phrase(180, MIXED)),
      expected: "needs-review",
      declared: official,
    },
    {
      path: "quiet.wav",
      label: "Silent source with a false C-minor declaration",
      bytes: wav(new Float32Array(RATE)),
      expected: "needs-review",
      declared: official,
    },
    {
      path: "other-tempo.wav",
      label: "135 BPM C-minor phrase with a false 180 BPM declaration",
      bytes: wav(phrase(135, NATURAL)),
      expected: "needs-conversion",
      declared: official,
    },
    {
      path: "truncated.wav",
      label: "Truncated WAV",
      bytes: truncated,
      expected: "unusable",
      declared: null,
    },
    {
      path: "invalid-channels.wav",
      label: "Invalid channel count",
      bytes: invalidChannels,
      expected: "unusable",
      declared: null,
    },
    {
      path: "nonfinite.wav",
      label: "Nonfinite floating-point sample",
      bytes: nonfinite,
      expected: "unusable",
      declared: null,
    },
  ];
}

test("generated source matrix records independent AC08 outcomes after analysis", async () => {
  const root = new LibraryDirectory();
  const cases = corpus();
  const counts = {
    correctReady: 0,
    incorrectReady: 0,
    review: 0,
    unusable: 0,
    conversion: 0,
  };
  for (const item of cases) {
    const file = new BinarySource(item.path, item.bytes);
    root.children.set(item.path, file);
    const before = createHash("sha256").update(item.bytes).digest("hex");
    const input = await file.getFile();
    if (item.expected === "unusable") {
      await assert.rejects(decodeWav(input), Error, item.label);
      counts.unusable++;
    } else {
      const decoded = await decodeWav(input);
      const analysis = analyzeAudio(decoded);
      const validated = await validateWav(input);
      if (!validated.valid) throw new Error(validated.reason);
      const saved = await saveAudioAnalysis(root, item.path, {
        sourceSha256: before,
        sourceBytes: input.size,
        info: validated.info,
        analysis,
        declared: item.declared,
      });
      const row = saved.samples[item.path];
      assert.ok(row, item.label);
      assert.equal(row.measured.status, item.expected, item.label);
      assert.deepEqual(row.declared, item.declared, item.label);
      if (row.measured.status === "ready") {
        if (item.expected === "ready") counts.correctReady++;
        else counts.incorrectReady++;
      } else if (row.measured.status === "needs-review") counts.review++;
      else counts.conversion++;
      if (item.path === "unpitched-one-shot.wav") {
        assert.equal(row.measured.measured.bpm, undefined);
        assert.equal(row.measured.measured.key, undefined);
      }
      if (item.declared && item.expected !== "ready")
        assert.notEqual(row.measured.status, "ready", item.label);
    }
    const after = createHash("sha256").update(file.bytes).digest("hex");
    assert.equal(after, before, item.label);
    assert.equal(file.writes, 0, item.label);
  }
  assert.equal(cases.length, 13);
  assert.deepEqual(counts, {
    correctReady: 6,
    incorrectReady: 0,
    review: 3,
    unusable: 3,
    conversion: 1,
  });
  const saved = await readAudioAnalysis(root);
  assert.equal(saved.status, "valid");
  if (saved.status !== "valid") throw new Error("Expected saved analysis.");
  assert.equal(Object.keys(saved.value.samples).length, 10);
  for (const item of cases.filter((entry) => entry.expected === "unusable"))
    assert.equal(saved.value.samples[item.path], undefined);
});
