export const PROJECT_SCHEMA_VERSION = 1;
export const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
export const MAX_TRACKS = 1024;
export const MAX_CLIPS = 100_000;

export interface Track {
  id: string;
  order: number;
  name: string;
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
}

export interface Clip {
  id: string;
  trackId: string;
  samplePath: string;
  startTick: number;
  durationTicks: number;
  sourceOffsetFrames: number;
  repeat: boolean;
  fadeInTicks: number;
  fadeOutTicks: number;
}

export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  revision: number;
  bpm: 180;
  key: "C minor";
  beatsPerBar: 4;
  ticksPerBeat: 960;
  masterGain: number;
  loop: { startTick: number; endTick: number } | null;
  tracks: Track[];
  clips: Clip[];
}

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectValidationError";
  }
}

function reject(message: string): never {
  throw new ProjectValidationError(message);
}

function record(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    reject(`${label} must be an object.`);
  }
  const data = value as Record<string, unknown>;
  const actual = Object.keys(data);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    reject(
      `${label} has missing or unsupported fields. Audio data is not permitted.`,
    );
  }
  return data;
}

function text(value: unknown, label: string, max = 200): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    reject(`${label} must be short, readable text.`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const id = text(value, label, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(id))
    reject(`${label} is not a valid identifier.`);
  return id;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    reject(`${label} must be a whole number of at least ${minimum}.`);
  }
  return value;
}

function number(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    reject(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") reject(`${label} must be true or false.`);
  return value;
}

export function validateSamplePath(value: unknown): string {
  const path = text(value, "Sample path", 4096);
  const segments = path.split("/");
  if (
    /[\\:*?"<>|]/u.test(path) ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255 ||
        /[. ]$/u.test(segment),
    ) ||
    !/\.wav$/iu.test(path)
  ) {
    reject("Sample paths must point to WAV files inside the sample folder.");
  }
  return path;
}

function validateTrack(value: unknown): Track {
  const track = record(
    value,
    ["id", "order", "name", "gain", "pan", "mute", "solo"],
    "Track",
  );
  return {
    id: identifier(track.id, "Track ID"),
    order: integer(track.order, "Track order"),
    name: text(track.name, "Track name"),
    gain: number(track.gain, "Track gain", 0, 4),
    pan: number(track.pan, "Track pan", -1, 1),
    mute: boolean(track.mute, "Track mute"),
    solo: boolean(track.solo, "Track solo"),
  };
}

function validateClip(value: unknown): Clip {
  const clip = record(
    value,
    [
      "id",
      "trackId",
      "samplePath",
      "startTick",
      "durationTicks",
      "sourceOffsetFrames",
      "repeat",
      "fadeInTicks",
      "fadeOutTicks",
    ],
    "Clip",
  );
  const result = {
    id: identifier(clip.id, "Clip ID"),
    trackId: identifier(clip.trackId, "Clip track ID"),
    samplePath: validateSamplePath(clip.samplePath),
    startTick: integer(clip.startTick, "Clip start"),
    durationTicks: integer(clip.durationTicks, "Clip duration", 1),
    sourceOffsetFrames: integer(clip.sourceOffsetFrames, "Source offset"),
    repeat: boolean(clip.repeat, "Clip repeat"),
    fadeInTicks: integer(clip.fadeInTicks, "Fade-in duration"),
    fadeOutTicks: integer(clip.fadeOutTicks, "Fade-out duration"),
  };
  if (!Number.isSafeInteger(result.startTick + result.durationTicks))
    reject("Clip end is too large.");
  if (result.fadeInTicks + result.fadeOutTicks > result.durationTicks)
    reject("Clip fades exceed its duration.");
  return result;
}

export function validateProject(value: unknown): Project {
  const data = record(
    value,
    [
      "schemaVersion",
      "id",
      "name",
      "revision",
      "bpm",
      "key",
      "beatsPerBar",
      "ticksPerBeat",
      "masterGain",
      "loop",
      "tracks",
      "clips",
    ],
    "Project",
  );
  if (data.schemaVersion !== PROJECT_SCHEMA_VERSION)
    reject("This project version is not supported.");
  if (data.bpm !== 180 || data.key !== "C minor")
    reject("Projects must use 180 BPM and C minor.");
  if (data.beatsPerBar !== 4 || data.ticksPerBeat !== 960)
    reject("This project time format is not supported.");
  if (!Array.isArray(data.tracks) || data.tracks.length > MAX_TRACKS)
    reject("The project has too many tracks or an invalid track list.");
  if (!Array.isArray(data.clips) || data.clips.length > MAX_CLIPS)
    reject("The project has too many clips or an invalid clip list.");
  const tracks = data.tracks.map(validateTrack);
  const clips = data.clips.map(validateClip);
  if (new Set(tracks.map((track) => track.id)).size !== tracks.length)
    reject("Track IDs must be unique.");
  if (new Set(tracks.map((track) => track.order)).size !== tracks.length)
    reject("Track order values must be unique.");
  if (new Set(clips.map((clip) => clip.id)).size !== clips.length)
    reject("Clip IDs must be unique.");
  const trackIds = new Set(tracks.map((track) => track.id));
  if (clips.some((clip) => !trackIds.has(clip.trackId)))
    reject("A clip refers to an absent track.");
  let loop: Project["loop"] = null;
  if (data.loop !== null) {
    const fields = record(data.loop, ["startTick", "endTick"], "Loop");
    loop = {
      startTick: integer(fields.startTick, "Loop start"),
      endTick: integer(fields.endTick, "Loop end", 1),
    };
    if (loop.endTick <= loop.startTick)
      reject("Loop end must follow its start.");
  }
  return {
    schemaVersion: 1,
    id: identifier(data.id, "Project ID"),
    name: text(data.name, "Project name"),
    revision: integer(data.revision, "Project revision"),
    bpm: 180,
    key: "C minor",
    beatsPerBar: 4,
    ticksPerBeat: 960,
    masterGain: number(data.masterGain, "Master gain", 0, 4),
    loop,
    tracks,
    clips,
  };
}

export function parseProject(source: string): Project {
  if (
    source.length > MAX_PROJECT_BYTES ||
    new TextEncoder().encode(source).byteLength > MAX_PROJECT_BYTES
  ) {
    reject("The project file exceeds the 16 MiB read limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    reject("The project file is not valid JSON.");
  }
  return validateProject(value);
}

export function createEmptyProject(name = "Untitled"): Project {
  return validateProject({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    revision: 0,
    bpm: 180,
    key: "C minor",
    beatsPerBar: 4,
    ticksPerBeat: 960,
    masterGain: 1,
    loop: null,
    tracks: Array.from({ length: 8 }, (_, order) => ({
      id: crypto.randomUUID(),
      order,
      name: `Track ${order + 1}`,
      gain: 1,
      pan: 0,
      mute: false,
      solo: false,
    })),
    clips: [],
  });
}

export function projectSamplePaths(project: Project): string[] {
  return [...new Set(project.clips.map((clip) => clip.samplePath))];
}
