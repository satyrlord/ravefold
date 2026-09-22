import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultAppearance,
  MAX_SETTINGS_BYTES,
  mergeAppearance,
  parseSettings,
  SettingsValidationError,
  validateSettings,
  type Appearance,
} from "../src/domain/settings.ts";
import { settingsFixture } from "./fixtures.ts";

test("appearance defaults honor reduced motion before folder access", () => {
  assert.deepEqual(defaultAppearance(), {
    skin: "reference-2",
    mode: "system",
    effects: "full",
  });
  assert.deepEqual(defaultAppearance(true), {
    skin: "reference-2",
    mode: "system",
    effects: "static",
  });
});

test("settings support all six skins and each independent mode and effects choice", () => {
  for (let index = 1; index <= 6; index++) {
    for (const mode of ["system", "light", "dark"]) {
      for (const effects of ["full", "reduced", "static"]) {
        const input = {
          schemaVersion: 1,
          appearance: { skin: `reference-${index}`, mode, effects },
        };
        assert.deepEqual(parseSettings(JSON.stringify(input)), input);
      }
    }
  }
});

test("settings reject unknown versions, fields, values and embedded content", () => {
  const good = settingsFixture();
  for (const value of [
    null,
    [],
    { ...good, schemaVersion: 2 },
    { ...good, audio: [] },
    { ...good, appearance: { ...good.appearance, skin: "reference-7" } },
    { ...good, appearance: { ...good.appearance, mode: "auto" } },
    { ...good, appearance: { ...good.appearance, effects: "off" } },
    { ...good, appearance: { ...good.appearance, audio: [] } },
  ]) {
    assert.throws(() => validateSettings(value), SettingsValidationError);
  }
  assert.throws(() => parseSettings("{"), /not valid JSON/u);
  assert.throws(
    () => parseSettings(" ".repeat(MAX_SETTINGS_BYTES + 1)),
    /read limit/u,
  );
});

test("only explicit session fields override saved settings", () => {
  const defaults = defaultAppearance(true);
  const saved = settingsFixture().appearance;
  const session: Appearance = {
    skin: "reference-4",
    mode: "light",
    effects: "static",
  };
  assert.deepEqual(mergeAppearance(defaults, saved, session, new Set()), saved);
  assert.deepEqual(
    mergeAppearance(defaults, saved, session, new Set(["skin"])),
    { ...saved, skin: "reference-4" },
  );
  assert.deepEqual(
    mergeAppearance(defaults, saved, session, new Set(["mode", "effects"])),
    { ...saved, mode: "light", effects: "static" },
  );
  assert.deepEqual(
    mergeAppearance(defaults, undefined, session, new Set(["skin"])),
    { ...defaults, skin: "reference-4" },
  );
  assert.deepEqual(defaults, defaultAppearance(true));
  assert.deepEqual(saved, settingsFixture().appearance);
});
