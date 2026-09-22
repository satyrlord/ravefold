export type Skin =
  | "reference-1"
  | "reference-2"
  | "reference-3"
  | "reference-4"
  | "reference-5"
  | "reference-6";
export type ThemeMode = "system" | "light" | "dark";
export type Effects = "full" | "reduced" | "static";

export interface Appearance {
  skin: Skin;
  mode: ThemeMode;
  effects: Effects;
}

export interface Settings {
  schemaVersion: 1;
  appearance: Appearance;
}

export const MAX_SETTINGS_BYTES = 16 * 1024;

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

function record(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new SettingsValidationError("Settings must contain valid objects.");
  const data = value as Record<string, unknown>;
  const actual = Object.keys(data);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  )
    throw new SettingsValidationError(
      "Settings have missing or unsupported fields.",
    );
  return data;
}

export function validateAppearance(value: unknown): Appearance {
  const appearance = record(value, ["skin", "mode", "effects"]);
  if (
    typeof appearance.skin !== "string" ||
    !/^reference-[1-6]$/u.test(appearance.skin)
  )
    throw new SettingsValidationError("The saved skin is not supported.");
  if (
    appearance.mode !== "system" &&
    appearance.mode !== "light" &&
    appearance.mode !== "dark"
  )
    throw new SettingsValidationError("The saved theme mode is not supported.");
  if (
    appearance.effects !== "full" &&
    appearance.effects !== "reduced" &&
    appearance.effects !== "static"
  )
    throw new SettingsValidationError(
      "The saved effects level is not supported.",
    );
  return {
    skin: appearance.skin as Skin,
    mode: appearance.mode,
    effects: appearance.effects,
  };
}

export function validateSettings(value: unknown): Settings {
  const settings = record(value, ["schemaVersion", "appearance"]);
  if (settings.schemaVersion !== 1)
    throw new SettingsValidationError(
      "This settings version is not supported.",
    );
  return {
    schemaVersion: 1,
    appearance: validateAppearance(settings.appearance),
  };
}

export function parseSettings(source: string): Settings {
  if (
    source.length > MAX_SETTINGS_BYTES ||
    new TextEncoder().encode(source).byteLength > MAX_SETTINGS_BYTES
  )
    throw new SettingsValidationError(
      "The settings file exceeds the 16 KiB read limit.",
    );
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new SettingsValidationError("The settings file is not valid JSON.");
  }
  return validateSettings(value);
}

export function defaultAppearance(reducedMotion = false): Appearance {
  return {
    skin: "reference-6",
    mode: "system",
    effects: reducedMotion ? "static" : "full",
  };
}

export function mergeAppearance(
  defaults: Appearance,
  saved: Appearance | undefined,
  session: Appearance,
  changed: ReadonlySet<keyof Appearance>,
): Appearance {
  const base = saved ?? defaults;
  return validateAppearance({
    skin: changed.has("skin") ? session.skin : base.skin,
    mode: changed.has("mode") ? session.mode : base.mode,
    effects: changed.has("effects") ? session.effects : base.effects,
  });
}
