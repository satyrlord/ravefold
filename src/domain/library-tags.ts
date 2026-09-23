import { validateSamplePath } from "./project.ts";

export const TAGS_FILENAME = "ravefold-tags.manifest.json";
export const TAGS_LOCK_FILENAME = ".ravefold-tags-write.manifest.json";
export const MAX_TAGS_BYTES = 4 * 1024 * 1024;
export const MAX_SAMPLE_TAGS = 32;
export const MAX_TAG_LENGTH = 40;

export interface TagManifest {
  schemaVersion: 1;
  revision: number;
  samples: Record<string, { tags: string[] }>;
}

function record(
  value: unknown,
  keys?: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Tag metadata must be an object.");
  const data = value as Record<string, unknown>;
  if (
    keys &&
    (Object.keys(data).length !== keys.length ||
      Object.keys(data).some((key) => !keys.includes(key)))
  )
    throw new Error("Tag metadata has missing or unsupported fields.");
  return data;
}

/** Preserve tag spelling. Matching does not depend on letter case. */
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SAMPLE_TAGS)
    throw new Error(`Use at most ${MAX_SAMPLE_TAGS} tags for each sample.`);
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || /[\u0000-\u001f\u007f,]/u.test(item))
      throw new Error(
        "Each tag must be text without commas or control characters.",
      );
    const tag = item.trim();
    if (!tag || tag.length > MAX_TAG_LENGTH)
      throw new Error(
        `Each tag must contain 1 to ${MAX_TAG_LENGTH} characters.`,
      );
    const key = tag.toLowerCase();
    if (!seen.has(key)) {
      tags.push(tag);
      seen.add(key);
    }
  }
  return tags;
}

export function emptyTagManifest(): TagManifest {
  return { schemaVersion: 1, revision: 0, samples: {} };
}

export function validateTagManifest(value: unknown): TagManifest {
  const data = record(value, ["schemaVersion", "revision", "samples"]);
  if (data.schemaVersion !== 1)
    throw new Error("The tag manifest version is not supported.");
  if (
    typeof data.revision !== "number" ||
    !Number.isSafeInteger(data.revision) ||
    data.revision < 0
  )
    throw new Error(
      "The tag manifest revision must be a nonnegative whole number.",
    );
  const entries = Object.entries(record(data.samples));
  if (entries.length > 100_000)
    throw new Error("The tag manifest contains too many sample records.");
  const samples: TagManifest["samples"] = {};
  for (const [path, value] of entries) {
    validateSamplePath(path);
    const row = record(value, ["tags"]);
    const tags = normalizeTags(row.tags);
    if (JSON.stringify(tags) !== JSON.stringify(row.tags))
      throw new Error(
        "Saved tags must be trimmed and unique without regard to letter case.",
      );
    samples[path] = { tags };
  }
  return { schemaVersion: 1, revision: data.revision, samples };
}

export function parseTagManifest(source: string): TagManifest {
  if (new TextEncoder().encode(source).byteLength > MAX_TAGS_BYTES)
    throw new Error("The tag manifest is too large.");
  return validateTagManifest(JSON.parse(source));
}
