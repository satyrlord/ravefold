import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEmptyProject,
  MAX_PROJECT_BYTES,
  MAX_TRACKS,
  parseProject,
  projectSamplePaths,
  ProjectValidationError,
  validateProject,
  validateSamplePath,
} from "../src/domain/project.ts";
import { createEntryResult } from "../src/domain/entry.ts";
import { defaultAppearance } from "../src/domain/settings.ts";
import type { DirectoryHandle } from "../src/storage/handles.ts";
import { projectFixture } from "./fixtures.ts";

test("project reads preserve arrangement and mixer metadata without source files", () => {
  const source = projectFixture();
  const loaded = parseProject(JSON.stringify(source));
  assert.deepEqual(loaded, source);
  assert.notEqual(loaded, source);
  assert.deepEqual(projectSamplePaths(loaded), [
    "Drums/kick.wav",
    "Bass/missing.wav",
  ]);
});

test("new projects have separate IDs and no audio or clips", () => {
  const first = createEmptyProject();
  const second = createEmptyProject();
  assert.equal(first.name, "Untitled");
  assert.equal(first.clips.length, 0);
  assert.equal(first.tracks.length, 8);
  assert.equal(first.bpm, 180);
  assert.equal(first.key, "C minor");
  assert.notEqual(first.id, second.id);
  assert.equal(
    new Set([...first.tracks, ...second.tracks].map((track) => track.id)).size,
    16,
  );
  assert.deepEqual(parseProject(JSON.stringify(first)), first);
});

test("invalid JSON, versions and fixed musical values are rejected", () => {
  assert.throws(() => parseProject("{"), /not valid JSON/u);
  for (const value of [null, [], 5, "project"])
    assert.throws(() => validateProject(value), ProjectValidationError);
  for (const [field, value] of [
    ["schemaVersion", 2],
    ["bpm", 90],
    ["key", "D minor"],
    ["beatsPerBar", 3],
    ["ticksPerBeat", 480],
  ]) {
    assert.throws(
      () => validateProject({ ...projectFixture(), [field as string]: value }),
      ProjectValidationError,
    );
  }
});

test("unsupported fields reject embedded audio at every object boundary", () => {
  const mutations = [
    (value: Record<string, unknown>) => {
      value.audio = "data:audio/wav;base64,AAAA";
    },
    (value: Record<string, unknown>) => {
      (value.tracks as object[])[0] = {
        ...(value.tracks as object[])[0],
        buffer: [1, 2],
      };
    },
    (value: Record<string, unknown>) => {
      (value.clips as object[])[0] = {
        ...(value.clips as object[])[0],
        samples: [1, 2],
      };
    },
    (value: Record<string, unknown>) => {
      value.loop = { startTick: 0, endTick: 960, audio: "AAAA" };
    },
  ];
  for (const mutate of mutations) {
    const fixture = JSON.parse(JSON.stringify(projectFixture())) as Record<
      string,
      unknown
    >;
    mutate(fixture);
    assert.throws(
      () => validateProject(fixture),
      /Audio data is not permitted/u,
    );
  }
});

test("sample paths reject absolute, escaping, ambiguous and non-WAV input", () => {
  for (const path of [
    "/sample.wav",
    "../sample.wav",
    "folder/../../sample.wav",
    "./sample.wav",
    "folder//sample.wav",
    "folder/.. /sample.wav",
    "folder./sample.wav",
    "C:/sample.wav",
    "C:\\sample.wav",
    "\\\\server\\sample.wav",
    "https://host/sample.wav",
    "data:audio/wav;base64,AAAA",
    "folder\\sample.wav",
    "sample.mp3",
    "sample.wav\u0000",
    "folder/sample.wav/",
    "folder/" + "x".repeat(256) + ".wav",
  ]) {
    assert.throws(() => validateSamplePath(path), ProjectValidationError, path);
  }
  assert.equal(
    validateSamplePath("Percussion/été 01.WAV"),
    "Percussion/été 01.WAV",
  );
  assert.equal(validateSamplePath("folder/%2e%2e.wav"), "folder/%2e%2e.wav");
});

test("duplicate IDs, missing tracks and unsafe positions are rejected", () => {
  const duplicate = projectFixture();
  duplicate.clips.push({ ...duplicate.clips[0]! });
  assert.throws(() => validateProject(duplicate), /Clip IDs/u);
  const absent = projectFixture();
  absent.clips[0]!.trackId = "absent";
  assert.throws(() => validateProject(absent), /absent track/u);
  const order = projectFixture();
  order.tracks[1]!.order = 0;
  assert.throws(() => validateProject(order), /order values/u);
  const duplicateTrack = projectFixture();
  duplicateTrack.tracks[1]!.id = duplicateTrack.tracks[0]!.id;
  assert.throws(() => validateProject(duplicateTrack), /Track IDs/u);
  for (const duration of [0, -1, 0.5, Infinity, NaN]) {
    const fixture = projectFixture();
    fixture.clips[0]!.durationTicks = duration;
    assert.throws(() => validateProject(fixture), ProjectValidationError);
  }
  const overflow = projectFixture();
  overflow.clips[0]!.startTick = Number.MAX_SAFE_INTEGER;
  assert.throws(() => validateProject(overflow), /too large/u);
  const fade = projectFixture();
  fade.clips[0]!.fadeInTicks = 7681;
  assert.throws(() => validateProject(fade), /fades exceed/u);
});

test("read guards reject excessive files and record counts", () => {
  assert.throws(
    () => parseProject(" ".repeat(MAX_PROJECT_BYTES + 1)),
    /read limit/u,
  );
  assert.throws(
    () => parseProject("é".repeat(MAX_PROJECT_BYTES / 2 + 1)),
    /read limit/u,
  );
  const fixture = projectFixture();
  fixture.tracks = Array.from({ length: MAX_TRACKS + 1 }, (_, order) => ({
    ...fixture.tracks[0]!,
    id: `track-${order}`,
    order,
  }));
  assert.throws(() => validateProject(fixture), /too many tracks/u);
});

test("entry retains every missing clip and transfers appearance without file calls", () => {
  const fixture = projectFixture();
  fixture.clips.push({
    ...fixture.clips[1]!,
    id: "clip-bass-2",
    startTick: 11520,
  });
  const untouched = JSON.stringify(fixture);
  const handle = new Proxy(
    { kind: "directory", name: "fixture" },
    {
      get(target, field) {
        if (field === "kind" || field === "name") return target[field];
        throw new Error("Entry must not read or write folders.");
      },
    },
  ) as DirectoryHandle;
  const appearance = { ...defaultAppearance(), effects: "static" as const };
  for (const mode of ["new", "open", "recover"] as const) {
    const entry = createEntryResult(
      mode,
      fixture,
      handle,
      handle,
      ["Bass/missing.wav", "unrelated.wav"],
      appearance,
    );
    assert.equal(entry.mode, mode);
    assert.equal(entry.samples, handle);
    assert.equal(entry.settings, handle);
    assert.deepEqual(entry.appearance, appearance);
    assert.notEqual(entry.appearance, appearance);
    assert.deepEqual(entry.missingSamples, [
      {
        clipId: "clip-bass",
        trackId: "track-bass",
        samplePath: "Bass/missing.wav",
        startTick: 3840,
        durationTicks: 3840,
      },
      {
        clipId: "clip-bass-2",
        trackId: "track-bass",
        samplePath: "Bass/missing.wav",
        startTick: 11520,
        durationTicks: 3840,
      },
    ]);
    assert.equal(JSON.stringify(entry.project), untouched);
  }
  assert.equal(JSON.stringify(fixture), untouched);
});
