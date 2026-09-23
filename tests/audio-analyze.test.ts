import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeAudio, AUDIO_ANALYSIS_VERSION } from "../src/audio/analyze.ts";
import { decodeWav, type DecodedWav } from "../src/audio/pcm.ts";

const SAMPLE_RATE = 48_000;
const C_NATURAL = [60, 63, 67, 68, 70, 67, 63, 60];
const C_HARMONIC = [60, 63, 67, 68, 71, 67, 63, 60];
const C_MELODIC = [60, 63, 67, 69, 71, 67, 63, 60];
const C_NATURAL_SHORT = [60, 63, 67, 68, 70, 60];
const C_HARMONIC_SHORT = [60, 63, 67, 68, 71, 60];
const C_MELODIC_SHORT = [60, 63, 67, 69, 71, 60];

function phrase(
  bpm: number,
  notes: readonly number[],
  options: {
    tuned?: boolean;
    mutedBeat?: number;
    sampleRate?: number;
    activeFraction?: number;
  } = {},
): DecodedWav {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const beatFrames = (sampleRate * 60) / bpm;
  const frames = Math.round(notes.length * beatFrames);
  const audio = new Float32Array(frames);
  for (let beat = 0; beat < notes.length; beat++) {
    if (beat === options.mutedBeat) continue;
    const start = Math.round(beat * beatFrames);
    const end = Math.round((beat + 1) * beatFrames);
    const active = Math.floor((end - start) * (options.activeFraction ?? 0.82));
    const frequency = 440 * 2 ** ((notes[beat]! - 69) / 12);
    const accent = bpm === 180 && beat % 4 === 0 ? 1.6 : 1;
    for (let frame = 0; frame < active; frame++) {
      const seconds = frame / sampleRate;
      const attack = Math.min(1, seconds / 0.006);
      const envelope = options.tuned
        ? Math.exp((-7 * frame) / (end - start))
        : 1;
      audio[start + frame] =
        0.45 *
        accent *
        attack *
        envelope *
        Math.sin(2 * Math.PI * frequency * seconds);
    }
  }
  return {
    sampleRate,
    frames,
    channels: [audio],
    encoding: "float32",
  };
}

function noise(
  seconds: number,
  pulses: number[] = [0],
  sampleRate = SAMPLE_RATE,
): DecodedWav {
  const frames = Math.round(seconds * sampleRate);
  const audio = new Float32Array(frames);
  let seed = 0x5a17;
  for (const pulse of pulses) {
    const start = Math.round(pulse * sampleRate);
    const active = Math.min(Math.round(sampleRate * 0.25), frames - start);
    for (let frame = 0; frame < active; frame++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const random = (seed >>> 0) / 0xffffffff;
      const envelope = Math.exp((-10 * frame) / active);
      audio[start + frame] = (random * 2 - 1) * envelope * 0.8;
    }
  }
  return {
    sampleRate,
    frames,
    channels: [audio],
    encoding: "float32",
  };
}

function coloredNoise(
  beats: number,
  offsets: readonly number[],
  activeBeats: number,
): DecodedWav {
  const sampleRate = 44_100;
  const beatFrames = sampleRate / 3;
  const frames = Math.round(beats * beatFrames);
  const audio = new Float32Array(frames);
  let seed = 0x5a17;
  for (const offset of offsets) {
    const start = Math.round(offset * beatFrames);
    const active = Math.floor(activeBeats * beatFrames);
    let state = 0;
    for (let frame = 0; frame < active && start + frame < frames; frame++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const raw = ((seed >>> 0) / 0xffffffff) * 2 - 1;
      state += 0.03 * (raw - state);
      const value = 2.5 * state * Math.exp((-5 * frame) / active);
      audio[start + frame] = Math.round(value * 32767) / 32768;
    }
  }
  return { sampleRate, frames, channels: [audio], encoding: "pcm16" };
}

function tonalOneShot(frequency: number): DecodedWav {
  const frames = Math.round(SAMPLE_RATE * 0.6);
  const audio = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const seconds = frame / SAMPLE_RATE;
    audio[frame] =
      0.6 *
      Math.exp((-8 * frame) / frames) *
      Math.sin(2 * Math.PI * frequency * seconds);
  }
  return {
    sampleRate: SAMPLE_RATE,
    frames,
    channels: [audio],
    encoding: "float32",
  };
}

function chordLoop(
  bpm: number,
  notes: readonly number[],
  beats = 8,
): DecodedWav {
  const components = notes.map((note) => phrase(bpm, Array(beats).fill(note)));
  const audio = components[0]!.channels[0]!.slice();
  audio.fill(0);
  for (const component of components)
    for (let frame = 0; frame < audio.length; frame++)
      audio[frame] += component.channels[0]![frame]! / notes.length;
  return { ...components[0]!, channels: [audio] };
}

test("measure supported tempo and each complete C-minor form", () => {
  for (const bpm of [90, 180]) {
    for (const [form, longNotes, shortNotes] of [
      ["natural", C_NATURAL, C_NATURAL_SHORT],
      ["harmonic", C_HARMONIC, C_HARMONIC_SHORT],
      ["melodic", C_MELODIC, C_MELODIC_SHORT],
    ] as const) {
      const notes = bpm === 90 ? longNotes : shortNotes;
      const analysis = analyzeAudio(phrase(bpm, notes));
      assert.equal(analysis.algorithmVersion, AUDIO_ANALYSIS_VERSION);
      assert.equal(
        analysis.status,
        "ready",
        JSON.stringify({ bpm, form, analysis }),
      );
      assert.equal(analysis.measured.sampleKind, "tonal-loop");
      assert.equal(analysis.measured.key, "C");
      assert.equal(analysis.measured.minorForm, form);
      assert.ok(Math.abs(analysis.measured.bpm! - bpm) < 1.5);
      assert.equal(analysis.measured.beatCount, notes.length);
    }
  }
});

test("measure an unpitched one-shot without tempo or key", () => {
  const audio = noise(0.6);
  const before = audio.channels[0]!.slice();
  const analysis = analyzeAudio(audio);
  assert.equal(analysis.status, "ready", JSON.stringify(analysis));
  assert.equal(analysis.measured.sampleKind, "unpitched-one-shot");
  assert.equal(Object.hasOwn(analysis.measured, "bpm"), false);
  assert.equal(Object.hasOwn(analysis.measured, "key"), false);
  assert.deepEqual(audio.channels[0], before);
  assert.equal(audio.frames / audio.sampleRate, 0.6);
});

test("measure a key-neutral 90 BPM drum loop", () => {
  const beat = 60 / 90;
  const pulses = Array.from({ length: 4 }, (_, index) => [
    index * beat,
    index * beat + beat / 4,
  ]).flat();
  const audio = noise(beat * 4, pulses);
  const analysis = analyzeAudio(audio);
  assert.equal(analysis.status, "ready", JSON.stringify(analysis));
  assert.equal(analysis.measured.sampleKind, "key-neutral-loop");
  assert.ok(Math.abs(analysis.measured.bpm! - 90) < 1.5);
  assert.equal(Object.hasOwn(analysis.measured, "key"), false);
});

test("measure syncopated loops from repeated envelope evidence", () => {
  const fastBeat = 60 / 180;
  const fastPulses = Array.from({ length: 6 }, (_, beat) => [
    beat * fastBeat,
    beat * fastBeat + fastBeat / 4,
  ]).flat();
  const fast = analyzeAudio(noise(fastBeat * 6, fastPulses));
  assert.equal(fast.status, "ready", JSON.stringify(fast));
  assert.equal(fast.measured.bpm, 180);

  const ambiguousPulses = Array.from({ length: 8 }, (_, beat) => [
    beat * fastBeat,
    beat * fastBeat + fastBeat / 4,
  ]).flat();
  const ambiguous = analyzeAudio(noise(fastBeat * 8, ambiguousPulses));
  assert.equal(ambiguous.status, "needs-review", JSON.stringify(ambiguous));
});

test("hold 90 BPM eighth notes that resemble 180 BPM quarter notes", () => {
  const eighth = 60 / 90 / 2;
  const pulses = Array.from({ length: 8 }, (_, index) => index * eighth);
  const analysis = analyzeAudio(noise((60 / 90) * 4, pulses));
  assert.equal(analysis.status, "needs-review", JSON.stringify(analysis));
  assert.match(analysis.reasons[0]!, /both 90 and 180 BPM/i);
  assert.equal(Object.hasOwn(analysis.measured, "bpm"), false);
});

test("hold accented 90 BPM eighth notes without tonal downbeat evidence", () => {
  const eighth = 60 / 90 / 2;
  const pulses = Array.from({ length: 8 }, (_, index) => index * eighth);
  const audio = noise((60 / 90) * 4, pulses);
  const samples = audio.channels[0]!;
  for (let frame = 0; frame < samples.length; frame++) samples[frame] *= 0.5;
  for (const index of [0, 4]) {
    const start = Math.round(index * eighth * SAMPLE_RATE);
    const end = Math.min(
      samples.length,
      start + Math.round(0.25 * SAMPLE_RATE),
    );
    for (let frame = start; frame < end; frame++) samples[frame] *= 1.6;
  }
  const analysis = analyzeAudio(audio);
  assert.equal(analysis.status, "needs-review", JSON.stringify(analysis));
});

test("hold a 90 BPM tonal eighth-note phrase that resembles 180 BPM", () => {
  const eighthNotes = phrase(180, C_NATURAL, { activeFraction: 0.8 });
  const analysis = analyzeAudio(eighthNotes);
  assert.equal(analysis.status, "needs-review", JSON.stringify(analysis));
  assert.equal(Object.hasOwn(analysis.measured, "bpm"), false);
  const verified = analyzeAudio(eighthNotes, { verifiedOfficialSource: true });
  assert.equal(verified.status, "ready", JSON.stringify(verified));
  assert.equal(verified.measured.bpm, 180);
});

test("hold uniform 90 BPM drum hits without subdivision evidence", () => {
  const beat = 60 / 90;
  const pulses = Array.from({ length: 4 }, (_, index) => index * beat);
  const analysis = analyzeAudio(noise(beat * 4, pulses));
  assert.equal(analysis.status, "needs-review", JSON.stringify(analysis));
  assert.match(analysis.reasons[0]!, /both 90 and 180 BPM/i);
});

test("hold a 60 BPM two-hit loop despite a verified 180 BPM declaration", () => {
  const source = noise(2, [0, 1]);
  assert.equal(analyzeAudio(source).status, "needs-review");
  const verified = analyzeAudio(source, { verifiedOfficialSource: true });
  assert.equal(verified.status, "needs-review", JSON.stringify(verified));
});

test("source-backed compatible loop records PCM evidence without a detected key", () => {
  const source = coloredNoise(6, [0, 0.75, 1.5, 2.5, 3.25, 4.75], 0.65);
  assert.equal(analyzeAudio(source).status, "needs-review");
  const verified = analyzeAudio(source, { verifiedOfficialSource: true });
  assert.equal(verified.status, "ready", JSON.stringify(verified));
  assert.equal(verified.measured.sampleKind, "source-backed-compatible-loop");
  assert.equal(verified.measured.bpm, 180);
  assert.equal(verified.measured.beatCount, 6);
  assert.equal(verified.measured.estimatedBpm, undefined);
  assert.equal(verified.measured.key, undefined);
  assert.equal(verified.measured.minorForm, undefined);
  const evidence = verified.measured.sourceBackedEvidence!;
  assert.equal(evidence.gridErrorBeats, 0);
  assert.equal(evidence.gridBeatsAt180, 6);
  assert.equal(evidence.attackCount, 6);
  assert.ok(evidence.peakRms >= 0.008);
  assert.ok(evidence.activeSpectralWindows >= 2);
  assert.ok(evidence.envelopeCorrelation180! >= 0.15);
  assert.equal(evidence.earlyPeakFraction, undefined);
  assert.equal(evidence.decayRatio, undefined);
  assert.equal(evidence.hardConflict, false);
  assert.equal(evidence.detuned, false);
  assert.equal(evidence.incompatibleClasses, false);
  assert.equal(evidence.incompatibleLines, false);
});

test("source-backed one-shot records decay without tempo or key", () => {
  const source = coloredNoise(2, [0], 1.6);
  assert.equal(analyzeAudio(source).status, "needs-review");
  const verified = analyzeAudio(source, { verifiedOfficialSource: true });
  assert.equal(verified.status, "ready", JSON.stringify(verified));
  assert.equal(verified.measured.sampleKind, "source-backed-one-shot");
  for (const field of ["bpm", "estimatedBpm", "beatCount", "key", "minorForm"])
    assert.equal(Object.hasOwn(verified.measured, field), false);
  const evidence = verified.measured.sourceBackedEvidence!;
  assert.equal(evidence.gridErrorBeats, 0);
  assert.equal(evidence.gridBeatsAt180, 2);
  assert.ok(evidence.attackCount >= 1);
  assert.ok(evidence.attackCount <= 3);
  assert.ok(evidence.peakRms >= 0.008);
  assert.ok(evidence.activeSpectralWindows >= 2);
  assert.ok(evidence.earlyPeakFraction! < 0.4);
  assert.ok(evidence.decayRatio! < 0.3);
  assert.equal(evidence.hardConflict, false);
  assert.equal(evidence.detuned, false);
  assert.equal(evidence.incompatibleClasses, false);
  assert.equal(evidence.incompatibleLines, false);
  source.loop = { startFrame: 0, endFrameExclusive: source.frames };
  assert.equal(
    analyzeAudio(source, { verifiedOfficialSource: true }).status,
    "needs-review",
  );
});

test("apply tonal rules to tuned percussion", () => {
  const compatible = analyzeAudio(
    phrase(180, C_HARMONIC_SHORT, { tuned: true }),
  );
  assert.equal(compatible.status, "ready", JSON.stringify(compatible));
  assert.equal(compatible.measured.sampleKind, "tuned-percussion");
  assert.equal(compatible.measured.minorForm, "harmonic");

  const major = analyzeAudio(
    phrase(180, [60, 64, 67, 69, 71, 60], { tuned: true }),
  );
  assert.equal(major.status, "needs-review");
  assert.equal(major.measured.sampleKind, "tuned-percussion");
  assert.equal(major.measured.minorForm, undefined);
});

test("hold mixed notes and accept a measured compatible one-note sound", () => {
  const mixed = analyzeAudio(phrase(180, [60, 63, 67, 64, 68, 60]));
  assert.equal(mixed.status, "needs-review");
  const oneNote = analyzeAudio(phrase(180, Array(6).fill(60), { tuned: true }));
  assert.equal(oneNote.status, "ready", JSON.stringify(oneNote));
  assert.equal(
    oneNote.measured.sampleKind,
    "tuned-percussion",
    JSON.stringify(oneNote),
  );
  assert.deepEqual(oneNote.measured.compatiblePitchClasses, [0]);
  assert.deepEqual(oneNote.measured.compatibleMinorForms, [
    "natural",
    "harmonic",
    "melodic",
  ]);
  assert.equal(oneNote.measured.key, undefined);
  assert.equal(oneNote.measured.minorForm, undefined);
  const shortHit = analyzeAudio(phrase(180, [60]));
  assert.equal(shortHit.status, "ready", JSON.stringify(shortHit));
  assert.equal(shortHit.measured.bpm, undefined);
});

test("accept a short compatible melody without inventing its minor form", () => {
  const analysis = analyzeAudio(phrase(180, [60, 63, 67, 60, 63, 67]));
  assert.equal(analysis.status, "ready", JSON.stringify(analysis));
  assert.deepEqual(analysis.measured.compatiblePitchClasses, [0, 3, 7]);
  assert.deepEqual(analysis.measured.compatibleMinorForms, [
    "natural",
    "harmonic",
    "melodic",
  ]);
  assert.equal(analysis.measured.key, undefined);
  assert.equal(analysis.measured.minorForm, undefined);
});

test("measure a syncopated 44.1 kHz mono PCM16 source with verified provenance", () => {
  const sampleRate = 44_100;
  const beatFrames = sampleRate / 3;
  const offsets = [0, 0.75, 1.5, 2.5, 3.25, 4.75];
  const notes = [60, 63, 67, 60, 63, 67];
  const frames = 6 * beatFrames;
  const audio = new Float32Array(frames);
  for (let event = 0; event < offsets.length; event++) {
    const start = Math.round(offsets[event]! * beatFrames);
    const active = Math.floor(beatFrames * 0.55);
    const frequency = 440 * 2 ** ((notes[event]! - 69) / 12);
    for (let frame = 0; frame < active; frame++) {
      const seconds = frame / sampleRate;
      const value =
        0.45 *
        Math.min(1, seconds / 0.006) *
        Math.exp((-2 * frame) / active) *
        Math.sin(2 * Math.PI * frequency * seconds);
      audio[start + frame] = Math.round(value * 32767) / 32768;
    }
  }
  const source: DecodedWav = {
    sampleRate,
    frames,
    channels: [audio],
    encoding: "pcm16",
  };
  assert.equal(analyzeAudio(source).status, "needs-review");
  const verified = analyzeAudio(source, { verifiedOfficialSource: true });
  assert.equal(verified.status, "ready", JSON.stringify(verified));
  assert.equal(verified.measured.bpm, 180);
  assert.ok(verified.measured.compatiblePitchClasses?.includes(3));
  assert.ok(verified.measured.compatiblePitchClasses?.includes(7));
});

test("measure a sustained one-beat source with verified provenance", () => {
  const source = phrase(180, [60], { sampleRate: 44_100, activeFraction: 1 });
  assert.equal(analyzeAudio(source).status, "needs-review");
  const verified = analyzeAudio(source, { verifiedOfficialSource: true });
  assert.equal(verified.status, "ready", JSON.stringify(verified));
  assert.equal(verified.measured.bpm, 180);
  assert.deepEqual(verified.measured.compatiblePitchClasses, [0]);
});

test("hold polyphonic major chords when monophonic pitch probes abstain", () => {
  for (const [bpm, notes] of [
    [90, [60, 64, 67]],
    [180, [72, 76, 79]],
  ] as const) {
    const analysis = analyzeAudio(chordLoop(bpm, notes));
    assert.equal(analysis.status, "needs-review", JSON.stringify(analysis));
  }
});

test("hold a noisy major chord with verified source context", () => {
  const source = chordLoop(180, [60, 64, 67]);
  const channel = source.channels[0]!;
  let seed = 0x5a17;
  for (let frame = 0; frame < channel.length; frame++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    channel[frame] += 0.3 * (((seed >>> 0) / 0xffffffff) * 2 - 1);
  }
  const analysis = analyzeAudio(source, { verifiedOfficialSource: true });
  assert.equal(analysis.status, "needs-review", JSON.stringify(analysis));
});

test("hold dense chromatic chords even when they resemble broad-spectrum noise", () => {
  for (const notes of [
    Array.from({ length: 8 }, (_, index) => 60 + index),
    Array.from({ length: 12 }, (_, index) => 60 + index),
  ]) {
    for (const noiseLevel of [0, 0.1, 0.3]) {
      const source = chordLoop(180, notes, 6);
      const channel = source.channels[0]!;
      let seed = 0x5a17;
      for (let frame = 0; frame < channel.length; frame++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        channel[frame] += noiseLevel * (((seed >>> 0) / 0xffffffff) * 2 - 1);
      }
      for (const context of [
        undefined,
        { verifiedOfficialSource: true } as const,
      ]) {
        const analysis = analyzeAudio(source, context);
        assert.equal(analysis.status, "needs-review", JSON.stringify(analysis));
      }
    }
  }
});

test("use persistent compatible notes in a noisy verified minor chord", () => {
  const source = chordLoop(180, [60, 63, 65, 67, 68], 6);
  const channel = source.channels[0]!;
  const beatFrames = (SAMPLE_RATE * 60) / 180;
  for (const beat of [0, 4]) {
    const start = Math.round(beat * beatFrames);
    const end = Math.round((beat + 1) * beatFrames);
    for (let frame = start; frame < end; frame++) channel[frame] /= 1.6;
  }
  let seed = 0x5a17;
  for (let frame = 0; frame < channel.length; frame++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    channel[frame] += 0.3 * (((seed >>> 0) / 0xffffffff) * 2 - 1);
  }
  assert.equal(analyzeAudio(source).status, "needs-review");
  const verified = analyzeAudio(source, { verifiedOfficialSource: true });
  assert.equal(verified.status, "ready", JSON.stringify(verified));
  assert.equal(verified.measured.sampleKind, "tonal-loop");
  assert.ok(verified.measured.compatiblePitchClasses?.length);
});

test("hold a decaying polyphonic major chord one-shot", () => {
  const components = [261.625565, 329.627557, 391.995436].map((frequency) =>
    tonalOneShot(frequency),
  );
  const chord = components[0]!.channels[0]!.slice();
  chord.fill(0);
  for (const component of components)
    for (let frame = 0; frame < chord.length; frame++)
      chord[frame] += component.channels[0]![frame]! / components.length;
  const source = { ...components[0]!, channels: [chord] };
  const analysis = analyzeAudio(source);
  assert.equal(analysis.status, "needs-review", JSON.stringify(analysis));
  assert.equal(Object.hasOwn(analysis.measured, "bpm"), false);
  assert.equal(
    analyzeAudio(source, { verifiedOfficialSource: true }).status,
    "needs-review",
  );
});

test("accept a measured C one-shot without a detected key or tempo", () => {
  const analysis = analyzeAudio(tonalOneShot(261.625565));
  assert.equal(analysis.status, "ready", JSON.stringify(analysis));
  assert.equal(analysis.measured.sampleKind, "tuned-percussion");
  assert.deepEqual(analysis.measured.compatiblePitchClasses, [0]);
  assert.equal(analysis.measured.key, undefined);
  assert.equal(analysis.measured.minorForm, undefined);
  assert.equal(analysis.measured.bpm, undefined);
});

test("hold low and high tonal one-shots outside the initial note range", () => {
  for (const frequency of [20, 80, 1568, 6000]) {
    const analysis = analyzeAudio(tonalOneShot(frequency));
    assert.equal(
      analysis.status,
      frequency === 1568 ? "ready" : "needs-review",
      JSON.stringify(analysis),
    );
    assert.notEqual(
      analysis.measured.sampleKind,
      "unpitched-one-shot",
      JSON.stringify({ frequency, analysis }),
    );
    if (frequency >= 80)
      assert.equal(
        analysis.measured.sampleKind,
        "tuned-percussion",
        JSON.stringify({ frequency, analysis }),
      );
    assert.equal(Object.hasOwn(analysis.measured, "bpm"), false);
  }
});

test("hold a quiet pitched tail after a noise transient", () => {
  const audio = noise(0.6);
  const channel = audio.channels[0]!;
  for (
    let frame = Math.round(0.26 * SAMPLE_RATE);
    frame < Math.round(0.55 * SAMPLE_RATE);
    frame++
  ) {
    const seconds = frame / SAMPLE_RATE - 0.26;
    channel[frame] += 0.05 * Math.sin(2 * Math.PI * 261.625565 * seconds);
  }
  const analysis = analyzeAudio(audio);
  assert.equal(analysis.status, "needs-review", JSON.stringify(analysis));
});

test("hold short tuned attacks that do not support pitch analysis", () => {
  const oneShot = tonalOneShot(523.251);
  oneShot.channels[0]!.fill(0, Math.round(SAMPLE_RATE * 0.025));
  assert.equal(analyzeAudio(oneShot).status, "needs-review");

  const loop = phrase(90, [60, 60, 60, 60]);
  const beatFrames = (SAMPLE_RATE * 60) / 90;
  for (let beat = 0; beat < 4; beat++) {
    const endOfAttack = Math.round(beat * beatFrames + SAMPLE_RATE * 0.025);
    const nextBeat = Math.round((beat + 1) * beatFrames);
    loop.channels[0]!.fill(0, endOfAttack, nextBeat);
  }
  assert.equal(analyzeAudio(loop).status, "needs-review");
});

test("require matching analysis from both stereo channels", () => {
  const compatible = phrase(180, C_NATURAL_SHORT);
  const quietSame = compatible.channels[0]!.map((value) => value * 0.2);
  const matching = analyzeAudio({
    ...compatible,
    channels: [compatible.channels[0]!, quietSame],
  });
  assert.equal(matching.status, "ready", JSON.stringify(matching));

  const major = phrase(180, [60, 64, 67, 69, 71, 60]);
  const quietMajor = major.channels[0]!.map((value) => value * 0.2);
  const conflict = analyzeAudio({
    ...compatible,
    channels: [compatible.channels[0]!, quietMajor],
  });
  assert.equal(conflict.status, "needs-review");
  assert.match(conflict.reasons[0]!, /stereo channels/i);

  const oneShot = noise(0.6);
  const quieterTone = tonalOneShot(80).channels[0]!.map((value) => value * 0.2);
  const splitOneShot = analyzeAudio({
    ...oneShot,
    channels: [oneShot.channels[0]!, quieterTone],
  });
  assert.equal(splitOneShot.status, "needs-review");

  const otherMinor = phrase(180, [60, 63, 67, 69, 71, 60]);
  const conflictingCompatible = analyzeAudio({
    ...compatible,
    channels: [compatible.channels[0]!, otherMinor.channels[0]!],
  });
  assert.equal(conflictingCompatible.status, "needs-review");
});

test("retain measured off-tempo BPM for conversion", () => {
  const analysis = analyzeAudio(phrase(135, C_NATURAL));
  assert.equal(analysis.status, "needs-conversion", JSON.stringify(analysis));
  assert.ok(Math.abs(analysis.measured.bpm! - 135) < 2);
  assert.equal(analysis.measured.key, "C");
  const gridAliased = analyzeAudio(phrase(135, C_NATURAL_SHORT), {
    verifiedOfficialSource: true,
  });
  assert.equal(gridAliased.status, "needs-review", JSON.stringify(gridAliased));
});

test("a verified source record cannot override measured foreign notes", () => {
  for (const notes of [
    [60, 64, 67, 69, 71, 60],
    [60, 63, 67, 64, 68, 60],
    [60, 63, 68, 69, 70, 60],
  ]) {
    for (const noiseLevel of [0, 0.3]) {
      const source = phrase(180, notes);
      const channel = source.channels[0]!;
      let seed = 0x5a17;
      for (let frame = 0; frame < channel.length; frame++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        channel[frame] += noiseLevel * (((seed >>> 0) / 0xffffffff) * 2 - 1);
      }
      const analysis = analyzeAudio(source, {
        verifiedOfficialSource: true,
      });
      assert.equal(analysis.status, "needs-review", JSON.stringify(analysis));
    }
  }
});

test("hold ambiguous rhythm, partial loop markers, and silence", () => {
  const sparse = analyzeAudio(phrase(180, C_NATURAL, { mutedBeat: 2 }));
  assert.equal(sparse.status, "needs-review");
  const partial = phrase(180, C_NATURAL);
  partial.loop = { startFrame: 100, endFrameExclusive: partial.frames };
  assert.equal(analyzeAudio(partial).status, "needs-review");
  assert.equal(analyzeAudio(noise(1, [])).status, "needs-review");
});

test("count labeled ready, incorrect-ready, review, conversion and unusable cases", async () => {
  const beat90 = 60 / 90;
  const beat180 = 60 / 180;
  const offbeat90 = Array.from({ length: 4 }, (_, index) => [
    index * beat90,
    index * beat90 + beat90 / 4,
  ]).flat();
  const offbeat180 = Array.from({ length: 6 }, (_, index) => [
    index * beat180,
    index * beat180 + beat180 / 4,
  ]).flat();
  const ready = [
    ...[90, 180].flatMap((bpm) =>
      (bpm === 90
        ? [C_NATURAL, C_HARMONIC, C_MELODIC]
        : [C_NATURAL_SHORT, C_HARMONIC_SHORT, C_MELODIC_SHORT]
      ).map((notes) => phrase(bpm, notes)),
    ),
    noise(0.6),
    noise(beat90 * 4, offbeat90),
    noise(beat180 * 6, offbeat180),
    phrase(180, C_HARMONIC_SHORT, { tuned: true }),
    phrase(180, Array(6).fill(60), { tuned: true }),
    tonalOneShot(261.625565),
  ];
  const partial = phrase(180, C_NATURAL);
  partial.loop = { startFrame: 100, endFrameExclusive: partial.frames };
  const review = [
    noise(beat90 * 4, [0, beat90, beat90 * 2, beat90 * 3]),
    noise(
      beat90 * 4,
      Array.from({ length: 8 }, (_, index) => (index * beat90) / 2),
    ),
    phrase(180, [60, 64, 67, 69, 71, 60], { tuned: true }),
    phrase(180, [60, 63, 67, 64, 68, 60]),
    phrase(180, C_NATURAL, { activeFraction: 0.8 }),
    chordLoop(90, [60, 64, 67]),
    tonalOneShot(80),
    partial,
    noise(1, []),
    phrase(180, C_NATURAL, { mutedBeat: 2 }),
  ];
  const conversion = [45, 135, 270].map((bpm) => phrase(bpm, C_NATURAL));
  const counts = {
    correctReady: 0,
    incorrectReady: 0,
    review: 0,
    conversion: 0,
    unusable: 0,
  };
  for (const [expected, samples] of [
    ["ready", ready],
    ["needs-review", review],
    ["needs-conversion", conversion],
  ] as const) {
    for (const sample of samples) {
      const actual = analyzeAudio(sample).status;
      if (actual === "ready") {
        if (expected === "ready") counts.correctReady++;
        else counts.incorrectReady++;
      } else if (actual === "needs-review") counts.review++;
      else counts.conversion++;
    }
  }
  for (const invalid of [new Blob([]), new Blob([new Uint8Array(44)])]) {
    try {
      await decodeWav(invalid);
    } catch {
      counts.unusable++;
    }
  }
  assert.deepEqual(counts, {
    correctReady: 12,
    incorrectReady: 0,
    review: 10,
    conversion: 3,
    unusable: 2,
  });
});

test("declared metadata cannot create or change an analysis result", () => {
  const major = phrase(180, [60, 64, 67, 69, 71, 60]);
  const falseMinorDeclaration = {
    ...major,
    declared: { bpm: 180, key: "C", minorForm: "harmonic" },
  };
  assert.deepEqual(analyzeAudio(falseMinorDeclaration), analyzeAudio(major));
  assert.equal(analyzeAudio(falseMinorDeclaration).status, "needs-review");

  const minor = phrase(180, C_NATURAL_SHORT);
  const falseMajorDeclaration = {
    ...minor,
    declared: { bpm: 135, key: "D", mode: "major" },
  };
  assert.deepEqual(analyzeAudio(falseMajorDeclaration), analyzeAudio(minor));
  assert.equal(analyzeAudio(minor).status, "ready");
});
