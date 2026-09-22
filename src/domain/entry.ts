import type { DirectoryHandle } from "../storage/handles.ts";
import { validateProject, type Project } from "./project.ts";
import { validateAppearance, type Appearance } from "./settings.ts";

export type EntryMode = "new" | "open" | "recover";

export interface MissingSample {
  clipId: string;
  trackId: string;
  samplePath: string;
  startTick: number;
  durationTicks: number;
}

export interface EntryResult {
  mode: EntryMode;
  project: Project;
  samples: DirectoryHandle;
  settings: DirectoryHandle;
  missingSamples: MissingSample[];
  appearance: Appearance;
}

export function createEntryResult(
  mode: EntryMode,
  project: Project,
  samples: DirectoryHandle,
  settings: DirectoryHandle,
  missingPaths: readonly string[],
  appearance: Appearance,
): EntryResult {
  const validated = validateProject(project);
  const absent = new Set(missingPaths);
  return {
    mode,
    project: validated,
    samples,
    settings,
    missingSamples: validated.clips
      .filter((clip) => absent.has(clip.samplePath))
      .map((clip) => ({
        clipId: clip.id,
        trackId: clip.trackId,
        samplePath: clip.samplePath,
        startTick: clip.startTick,
        durationTicks: clip.durationTicks,
      })),
    appearance: validateAppearance(appearance),
  };
}
