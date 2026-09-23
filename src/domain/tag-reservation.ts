export const TAG_RESERVATION_PATTERN =
  /^\.ravefold-tags-lock-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.manifest\.json$/u;
export const MAX_TAG_RESERVATION_BYTES = 256;
export const TAG_RESERVATION_BUSY_MESSAGE =
  "Tag changes are blocked. Close every RaveFold browser tab and editor session. In the sample folder, remove only abandoned .ravefold-tags-lock-<uuid>.manifest.json files and .ravefold-tags-write.manifest.json. Keep ravefold-tags.manifest.json and all audio files. Then open RaveFold and retry.";

export interface TagReservationRecord {
  schemaVersion: 1;
  owner: string;
  choosing: boolean;
  ticket: number;
}

export function tagReservationName(owner: string): string {
  const name = `.ravefold-tags-lock-${owner}.manifest.json`;
  if (!TAG_RESERVATION_PATTERN.test(name))
    throw new Error("The tag reservation identifier is invalid.");
  return name;
}

export function parseTagReservation(
  source: string,
  name: string,
): TagReservationRecord {
  if (new TextEncoder().encode(source).byteLength > MAX_TAG_RESERVATION_BYTES)
    throw new Error("The tag reservation is too large.");
  const owner = TAG_RESERVATION_PATTERN.exec(name)?.[1];
  const value: unknown = JSON.parse(source);
  if (!owner || !value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The tag reservation is invalid.");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    record.schemaVersion !== 1 ||
    record.owner !== owner ||
    typeof record.choosing !== "boolean" ||
    typeof record.ticket !== "number" ||
    !Number.isSafeInteger(record.ticket) ||
    record.ticket < 0 ||
    (record.choosing ? record.ticket !== 0 : record.ticket === 0)
  )
    throw new Error("The tag reservation is invalid.");
  return {
    schemaVersion: 1,
    owner,
    choosing: record.choosing,
    ticket: record.ticket,
  };
}
