import { validateSamplePath } from "./project.ts";

export const SOURCE_MANIFEST_FILENAME = "ravefold-sources.manifest.json";
export const MAX_SOURCE_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_RECORDS = 20_000;

export interface SourceRecord {
  sha256: string;
  bytes: number;
  declared: { bpm: 180; key: "C minor" };
  provenance: "user-attested-og" | "og-archive-import";
}

export interface SourceManifest {
  schemaVersion: 1;
  revision: number;
  sources: Record<string, SourceRecord>;
}

function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Source metadata must be an object.");
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(fields, key)) ||
    Object.keys(fields).some((key) => !keys.includes(key))
  )
    throw new Error("Source metadata has missing or unsupported fields.");
  return fields;
}

export function validateSourceRecord(value: unknown): SourceRecord {
  const data = object(value, ["sha256", "bytes", "declared", "provenance"]);
  if (typeof data.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(data.sha256))
    throw new Error("The source hash is invalid.");
  if (
    typeof data.bytes !== "number" ||
    !Number.isSafeInteger(data.bytes) ||
    data.bytes < 44
  )
    throw new Error("The source byte count is invalid.");
  const declared = object(data.declared, ["bpm", "key"]);
  if (declared.bpm !== 180 || declared.key !== "C minor")
    throw new Error("The official source declaration is invalid.");
  if (
    data.provenance !== "user-attested-og" &&
    data.provenance !== "og-archive-import"
  )
    throw new Error("The source provenance is invalid.");
  return {
    sha256: data.sha256,
    bytes: data.bytes,
    declared: { bpm: 180, key: "C minor" },
    provenance: data.provenance,
  };
}

export function validateSourceManifest(value: unknown): SourceManifest {
  const data = object(value, ["schemaVersion", "revision", "sources"]);
  if (data.schemaVersion !== 1)
    throw new Error("The source manifest version is not supported.");
  if (
    typeof data.revision !== "number" ||
    !Number.isSafeInteger(data.revision) ||
    data.revision < 0
  )
    throw new Error("The source manifest revision is invalid.");
  if (
    !data.sources ||
    typeof data.sources !== "object" ||
    Array.isArray(data.sources)
  )
    throw new Error("The source records are invalid.");
  const entries = Object.entries(data.sources);
  if (entries.length > MAX_SOURCE_RECORDS)
    throw new Error("The source manifest has too many records.");
  const sources: SourceManifest["sources"] = {};
  for (const [path, record] of entries)
    sources[validateSamplePath(path)] = validateSourceRecord(record);
  return { schemaVersion: 1, revision: data.revision, sources };
}

export function parseSourceManifest(source: string): SourceManifest {
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_MANIFEST_BYTES)
    throw new Error("The source manifest is too large.");
  return validateSourceManifest(JSON.parse(source));
}
