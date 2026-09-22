import type { Project } from "../src/domain/project.ts";
import type { Settings } from "../src/domain/settings.ts";

export function projectFixture(): Project {
  return {
    schemaVersion: 1,
    id: "project-fixture",
    name: "Fixture arrangement",
    revision: 3,
    bpm: 180,
    key: "C minor",
    beatsPerBar: 4,
    ticksPerBeat: 960,
    masterGain: 0.8,
    loop: { startTick: 0, endTick: 7680 },
    tracks: [
      {
        id: "track-drums",
        order: 0,
        name: "Drums",
        gain: 0.75,
        pan: -0.25,
        mute: false,
        solo: false,
      },
      {
        id: "track-bass",
        order: 1,
        name: "Bass",
        gain: 1,
        pan: 0.2,
        mute: false,
        solo: true,
      },
    ],
    clips: [
      {
        id: "clip-drums",
        trackId: "track-drums",
        samplePath: "Drums/kick.wav",
        startTick: 0,
        durationTicks: 7680,
        sourceOffsetFrames: 0,
        repeat: true,
        fadeInTicks: 0,
        fadeOutTicks: 0,
      },
      {
        id: "clip-bass",
        trackId: "track-bass",
        samplePath: "Bass/missing.wav",
        startTick: 3840,
        durationTicks: 3840,
        sourceOffsetFrames: 120,
        repeat: false,
        fadeInTicks: 60,
        fadeOutTicks: 120,
      },
    ],
  };
}

export function settingsFixture(): Settings {
  return {
    schemaVersion: 1,
    appearance: { skin: "reference-5", mode: "dark", effects: "reduced" },
  };
}
