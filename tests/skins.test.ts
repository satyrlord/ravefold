import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  getMaterialProps,
  getSkinSettings,
  REFERENCE_DEFAULTS,
  SKIN_PATCHES,
  SKINS,
} from "../src/skins/registry.ts";

// These checksums use the complete settings at the fixed reference revision.
const expected = [
  "c0f85a9d65f20ce6c8d0a55095d50a119e82ae74c26ccd36e50e9c269c7b80d8",
  "7ed09f72958bad7656b18f2d02b1f4b172a9aa69edbdc0cc75275873a2856699",
  "a234e853f30a752a385e79b74bd4f0b3b246e97dbca59a8aaef900a89a95fd12",
  "0673f2777b1465332e7287b4c46c86d787ac723b67f43c4077796023c0a0a4fd",
  "b86b57f559f43f2ce621cc876f76cac52bdfafb54f0a3a5b46e3b0ac06f113eb",
  "79c084ac5d891731135f3940b4d444248af4d9889b395d07f3d24f4e1bce289f",
];

test("skin names match the six reference presets", () => {
  assert.deepEqual(
    SKINS.map(({ id, label }) => ({ id, label })),
    [
      { id: "reference-1", label: "Lumen" },
      { id: "reference-2", label: "Studio" },
      { id: "reference-3", label: "Slate" },
      { id: "reference-4", label: "Aqua" },
      { id: "reference-5", label: "Neon" },
      { id: "reference-6", label: "Entropy" },
    ],
  );
});

test("all six definitions match the fixed reference settings", () => {
  assert.equal(SKINS.length, expected.length);
  SKINS.forEach((skin, index) => {
    const config = getSkinSettings(skin.id);
    const digest = createHash("sha256")
      .update(JSON.stringify(config, Object.keys(config).sort()))
      .digest("hex");
    assert.equal(digest, expected[index], skin.label);
  });
});

test("skin changes cannot retain a prior patch or mutate shared defaults", () => {
  const baseline = getSkinSettings("reference-2");
  for (const skin of SKINS) {
    const current = getSkinSettings(skin.id);
    assert.ok(Object.isFrozen(current));
    assert.ok(Object.isFrozen(SKIN_PATCHES[skin.id]));
  }
  assert.ok(Object.isFrozen(REFERENCE_DEFAULTS));
  assert.deepEqual(getSkinSettings("reference-2"), baseline);
  assert.equal(baseline.rimHex, "#9ff3e4");
  assert.equal(baseline.ambientDrops, false);
});

test("full renderer props preserve the reference material parameters", () => {
  for (const skin of SKINS) {
    const config = getSkinSettings(skin.id);
    const props = getMaterialProps(
      { skin: skin.id, mode: "dark", effects: "full" },
      "dark",
    );
    for (const key of [
      "blend",
      "refraction",
      "dispersion",
      "rim",
      "radius",
      "tint",
      "opacity",
      "frost",
      "elevation",
      "viscosity",
      "stretch",
      "flow",
      "rimWidth",
      "highlight",
      "edgeLine",
      "shimmer",
      "glow",
      "wash",
      "grain",
      "backgroundBlur",
      "smoothness",
      "pointerDrop",
      "pointerPull",
      "ambientDrops",
      "grid",
      "magnet",
      "mood",
    ] as const) {
      assert.equal(props[key], config[key], `${skin.id}: ${key}`);
    }
    assert.equal(
      props.rimColor,
      config.rimStyle === "color" ? config.rimHex : config.rimStyle,
    );
  }
});

test("reduced effects lower motion without changing the selected material", () => {
  for (const skin of SKINS) {
    const config = getSkinSettings(skin.id);
    const props = getMaterialProps(
      { skin: skin.id, mode: "dark", effects: "reduced" },
      "dark",
    );
    assert.ok((props.flow ?? 0) <= config.flow);
    assert.ok((props.stretch ?? 0) <= config.stretch);
    assert.equal(props.ambientDrops, false);
    assert.equal(props.pointerDrop, false);
    assert.equal(props.pointerPull, false);
    assert.equal(props.opacity, config.opacity);
    assert.equal(props.frost, config.frost);
  }
});

test("light theme lifts opaque tints while preserving the reference registry", () => {
  for (const skin of SKINS) {
    const config = getSkinSettings(skin.id);
    const props = getMaterialProps(
      { skin: skin.id, mode: "light", effects: "full" },
      "light",
    );
    assert.equal(props.theme, "light");
    assert.equal(props.opacity, config.opacity);
    assert.equal(props.frost, config.frost);
    if (config.opacity >= 0.55) assert.notEqual(props.tint, config.tint);
    else assert.equal(props.tint, config.tint);
  }
});
