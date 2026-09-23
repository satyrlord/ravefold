import { expect, test, type Page } from "@playwright/test";
import {
  AUDIO_MANIFEST_FILENAME,
  parseAudioManifest,
} from "../../src/domain/audio-manifest.ts";
import {
  PAIR_MANIFEST_FILENAME,
  parsePairManifest,
} from "../../src/domain/pair-manifest.ts";
import {
  installFixtureFS,
  snapshotFS,
  type FixtureOptions,
} from "./fixture-fs.ts";

test.use({ contextOptions: { reducedMotion: "reduce" } });

async function start(
  page: Page,
  options: FixtureOptions = {},
): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installFixtureFS(page, { analysisSamples: true, ...options });
  await page.goto("/");
  return errors;
}

async function enter(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Folder settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Folder settings",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Select sample folder", exact: true })
    .click();
  await expect(
    dialog.getByText("Sample folder is ready.", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Select settings folder", exact: true })
    .click();
  await expect(
    dialog.getByText("Settings folder is ready.", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page
    .getByRole("button", { name: "Enter tracker", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Samples", exact: true }),
  ).toBeVisible();
}

function sample(page: Page, path: string) {
  return page.getByRole("button", { name: path, exact: true });
}

function inspector(page: Page) {
  return page.getByRole("region", { name: "Sample inspector", exact: true });
}

async function status(page: Page, expected: string) {
  const readiness = inspector(page).locator(".sample-readiness");
  await expect(readiness).toHaveText(expected);
  return readiness;
}

test("compatible C-minor audio becomes ready with a source reference that survives reload", async ({
  page,
}) => {
  const errors = await start(page);
  await enter(page);
  const before = await snapshotFS(page);
  const path = "Analysis/c-natural-180.wav";
  await sample(page, path).click();
  await status(page, "Ready");
  await expect(
    inspector(page).getByText("tonal loop", { exact: true }),
  ).toBeVisible();
  await expect(
    inspector(page).getByText("180 BPM", { exact: true }),
  ).toBeVisible();
  await expect(
    inspector(page).getByText("C natural minor", { exact: true }),
  ).toBeVisible();
  await expect(
    inspector(page).getByRole("button", {
      name: "Play ready source",
      exact: true,
    }),
  ).toBeVisible();
  const saved = await snapshotFS(page);
  const manifest = parseAudioManifest(
    saved.sampleMetadata[AUDIO_MANIFEST_FILENAME],
  );
  const sourceHash = before.audio.find(
    (entry) => entry.path === `Sample library/${path}`,
  )!.hash;
  expect(manifest.samples[path]?.sourceSha256).toBe(sourceHash);
  expect(manifest.samples[path]?.measured.status).toBe("ready");
  expect(manifest.samples[path]?.measured.measured.bpm).toBe(180);
  expect(manifest.samples[path]?.measured.measured.minorForm).toBe("natural");
  expect(manifest.samples[path]?.declared).toBeNull();
  expect(manifest.samples[path]?.corrected).toBeNull();
  expect(saved.audio).toEqual(before.audio);
  expect(saved.settings).toEqual(before.settings);
  expect(
    saved.writes.some(
      (write) => write.path === `Sample library/${AUDIO_MANIFEST_FILENAME}`,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ local: [], session: [] });

  await page.reload();
  await enter(page);
  await sample(page, path).click();
  await status(page, "Ready");
  const again = await snapshotFS(page);
  expect(again.sampleMetadata[AUDIO_MANIFEST_FILENAME]).toBe(
    saved.sampleMetadata[AUDIO_MANIFEST_FILENAME],
  );
  expect(again.audio).toEqual(before.audio);
  expect(errors).toEqual([]);
});

test("verified source evidence resolves an analyzed tempo alias", async ({
  page,
}) => {
  const errors = await start(page, { sourceClaim: "matching" });
  await enter(page);
  const path = "Analysis/ambiguous-180.wav";
  const before = await snapshotFS(page);
  await sample(page, path).click();
  await status(page, "Ready");
  const saved = parseAudioManifest(
    (await snapshotFS(page)).sampleMetadata[AUDIO_MANIFEST_FILENAME],
  ).samples[path];
  expect(saved?.declared).toEqual({
    source: "og-collection",
    bpm: 180,
    key: "C minor",
  });
  expect(saved?.sourceSha256).toBe(
    before.audio.find((entry) => entry.path === `Sample library/${path}`)!.hash,
  );
  expect((await snapshotFS(page)).audio).toEqual(before.audio);
  expect(errors).toEqual([]);
});

test("source-backed results retain measured evidence without an invented key", async ({
  page,
}) => {
  const errors = await start(page, { sourceClaim: "matching" });
  await enter(page);
  const before = await snapshotFS(page);
  const loop = "Analysis/source-backed-loop.wav";
  await sample(page, loop).click();
  await status(page, "Ready");
  await expect(
    inspector(page).getByText("Validated source tempo", { exact: true }),
  ).toBeVisible();
  await expect(
    inspector(page).getByText("Measured key", { exact: true }),
  ).toHaveCount(0);
  let records = parseAudioManifest(
    (await snapshotFS(page)).sampleMetadata[AUDIO_MANIFEST_FILENAME],
  ).samples;
  expect(records[loop]?.measured.measured.sampleKind).toBe(
    "source-backed-compatible-loop",
  );
  expect(records[loop]?.measured.measured.bpm).toBe(180);
  expect(records[loop]?.measured.measured.sourceBackedEvidence).toBeDefined();
  expect(records[loop]?.declared?.key).toBe("C minor");

  const oneShot = "Analysis/source-backed-one-shot.wav";
  await sample(page, oneShot).click();
  await status(page, "Ready");
  records = parseAudioManifest(
    (await snapshotFS(page)).sampleMetadata[AUDIO_MANIFEST_FILENAME],
  ).samples;
  expect(records[oneShot]?.measured.measured.sampleKind).toBe(
    "source-backed-one-shot",
  );
  expect(records[oneShot]?.measured.measured.bpm).toBeUndefined();
  expect(records[oneShot]?.measured.measured.key).toBeUndefined();
  expect(
    records[oneShot]?.measured.measured.sourceBackedEvidence,
  ).toBeDefined();
  expect((await snapshotFS(page)).audio).toEqual(before.audio);
  expect(errors).toEqual([]);
});

test("a source claim with the wrong hash cannot resolve a tempo alias", async ({
  page,
}) => {
  const errors = await start(page, { sourceClaim: "mismatched" });
  await enter(page);
  const path = "Analysis/ambiguous-180.wav";
  const before = await snapshotFS(page);
  await sample(page, path).click();
  await status(page, "Needs review");
  const after = await snapshotFS(page);
  const stale = parseAudioManifest(
    after.sampleMetadata[AUDIO_MANIFEST_FILENAME],
  ).samples[path];
  expect(stale?.declared).toBeNull();
  expect(after.audio).toEqual(before.audio);
  expect(errors).toEqual([]);
});

test("an unpitched one-shot has no invented tempo or key and a 90 BPM drum loop is ready", async ({
  page,
}) => {
  const errors = await start(page);
  await enter(page);
  const before = await snapshotFS(page);
  const oneShot = "Analysis/noise-one-shot.wav";
  await sample(page, oneShot).click();
  await status(page, "Ready");
  await expect(
    inspector(page).getByText("unpitched one shot", { exact: true }),
  ).toBeVisible();
  await expect(inspector(page).getByText("Measured tempo")).toHaveCount(0);
  await expect(inspector(page).getByText("Measured key")).toHaveCount(0);
  const oneShotSaved = parseAudioManifest(
    (await snapshotFS(page)).sampleMetadata[AUDIO_MANIFEST_FILENAME],
  ).samples[oneShot];
  expect(oneShotSaved?.measured.status).toBe("ready");
  expect(oneShotSaved?.measured.measured.sampleKind).toBe("unpitched-one-shot");
  expect(Object.hasOwn(oneShotSaved!.measured.measured, "bpm")).toBe(false);
  expect(Object.hasOwn(oneShotSaved!.measured.measured, "key")).toBe(false);
  expect(oneShotSaved?.wav.duration).toBe(0.6);

  const loop = "Analysis/drum-loop-90.wav";
  await sample(page, loop).click();
  await status(page, "Ready");
  await expect(
    inspector(page).getByText("key neutral loop", { exact: true }),
  ).toBeVisible();
  await expect(
    inspector(page).getByText("90 BPM", { exact: true }),
  ).toBeVisible();
  const after = await snapshotFS(page);
  const manifest = parseAudioManifest(
    after.sampleMetadata[AUDIO_MANIFEST_FILENAME],
  );
  expect(manifest.samples[loop]?.measured.measured.bpm).toBe(90);
  expect(manifest.samples[loop]?.sourceSha256).toBe(
    before.audio.find((entry) => entry.path === `Sample library/${loop}`)!.hash,
  );
  expect(after.audio).toEqual(before.audio);
  expect(after.settings).toEqual(before.settings);
  expect(errors).toEqual([]);
});

test("invalid audio cannot become ready or receive a manifest record", async ({
  page,
}) => {
  const errors = await start(page);
  await enter(page);
  const before = await snapshotFS(page);
  const path = "Analysis/broken.wav";
  await sample(page, path).click();
  await status(page, "Unusable");
  await expect(
    inspector(page)
      .getByRole("region", { name: "Audio analysis" })
      .getByText("The WAV header is incomplete.", { exact: true }),
  ).toBeVisible();
  const after = await snapshotFS(page);
  expect(after.audio).toEqual(before.audio);
  expect(after.sampleMetadata[AUDIO_MANIFEST_FILENAME]).toBeUndefined();
  expect(after.settings).toEqual(before.settings);
  expect(errors).toEqual([]);
});

test("a cancelled old selection cannot replace the latest result or save stale analysis", async ({
  page,
}) => {
  const errors = await start(page);
  await enter(page);
  const before = await snapshotFS(page);
  const held = "Analysis/c-natural-180.wav";
  const latest = "Analysis/noise-one-shot.wav";
  await page.evaluate((path) => window.fixtureFS.holdAudioRead(path), held);
  await sample(page, held).click();
  await expect(inspector(page).locator(".relative-path").first()).toHaveText(
    held,
  );
  await sample(page, latest).click();
  await status(page, "Ready");
  await page.evaluate(() => window.fixtureFS.releaseAudioRead());
  await expect(inspector(page).locator(".relative-path").first()).toHaveText(
    latest,
  );
  await status(page, "Ready");
  const after = await snapshotFS(page);
  const manifest = parseAudioManifest(
    after.sampleMetadata[AUDIO_MANIFEST_FILENAME],
  );
  expect(manifest.samples[latest]?.measured.status).toBe("ready");
  expect(manifest.samples[held]).toBeUndefined();
  expect(after.audio).toEqual(before.audio);
  expect(errors).toEqual([]);
});

test("explicit stereo pairing checks both channels and keeps source audio", async ({
  page,
}) => {
  const errors = await start(page);
  await enter(page);
  const before = await snapshotFS(page);
  const left = "Analysis/pair-left.wav";
  const right = "Analysis/pair-right.wav";
  await sample(page, left).click();
  await status(page, "Ready");
  const leftButton = inspector(page).getByRole("button", {
    name: "Use as left",
    exact: true,
  });
  await leftButton.focus();
  await page.keyboard.press("Enter");
  await expect(leftButton).toHaveAttribute("aria-pressed", "true");
  await sample(page, right).click();
  await status(page, "Ready");
  await inspector(page)
    .getByRole("button", { name: "Use as right", exact: true })
    .click();
  await inspector(page)
    .getByRole("button", { name: "Confirm and check pair", exact: true })
    .click();
  await expect(
    inspector(page).getByText("Pair ready. Both channels passed analysis."),
  ).toBeVisible();
  const after = await snapshotFS(page);
  const manifest = parsePairManifest(
    after.sampleMetadata[PAIR_MANIFEST_FILENAME],
  );
  const pairs = Object.values(manifest.pairs);
  expect(pairs).toHaveLength(1);
  expect(pairs[0]?.left.path).toBe(left);
  expect(pairs[0]?.right.path).toBe(right);
  expect(pairs[0]?.analysis.status).toBe("ready");
  expect(pairs[0]?.left.sourceSha256).toBe(
    before.audio.find((entry) => entry.path === `Sample library/${left}`)!.hash,
  );
  expect(pairs[0]?.right.sourceSha256).toBe(
    before.audio.find((entry) => entry.path === `Sample library/${right}`)!
      .hash,
  );
  expect(after.audio).toEqual(before.audio);
  expect(after.settings).toEqual(before.settings);
  expect(errors).toEqual([]);

  await inspector(page)
    .getByRole("button", { name: "Clear pair", exact: true })
    .click();
  await sample(page, left).click();
  await status(page, "Ready");
  await inspector(page)
    .getByRole("button", { name: "Use as left", exact: true })
    .click();
  await sample(page, "Analysis/pair-shifted.wav").click();
  await status(page, "Needs review");
  await inspector(page)
    .getByRole("button", { name: "Use as right", exact: true })
    .click();
  await inspector(page)
    .getByRole("button", { name: "Confirm and check pair", exact: true })
    .click();
  await expect(
    inspector(page).getByText(/channel onsets do not align/i),
  ).toBeVisible();
  const rejected = await snapshotFS(page);
  expect(
    Object.keys(
      parsePairManifest(rejected.sampleMetadata[PAIR_MANIFEST_FILENAME]).pairs,
    ),
  ).toHaveLength(1);
  expect(rejected.audio).toEqual(before.audio);
});

test("unavailable audio analysis keeps source preview and tags usable", async ({
  page,
}) => {
  const errors = await start(page);
  await enter(page);
  const before = await snapshotFS(page);
  await page.evaluate(() => {
    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: undefined,
    });
  });
  await sample(page, "Analysis/c-natural-180.wav").click();
  await status(page, "Analysis unavailable");
  await expect(
    inspector(page).getByText(
      "Audio analysis is unavailable in this browser.",
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Ready", exact: true }),
  ).toHaveCount(0);

  await inspector(page)
    .getByRole("button", { name: "Play source", exact: true })
    .click();
  await expect(
    page.getByText("Source preview is playing.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();

  const tag = inspector(page).getByRole("textbox", {
    name: "New tag",
    exact: true,
  });
  await expect(tag).toBeEnabled();
  await tag.fill("still usable");
  await inspector(page)
    .getByRole("button", { name: "Add tag", exact: true })
    .click();
  await inspector(page)
    .getByRole("button", { name: "Save tags", exact: true })
    .click();
  await expect(
    inspector(page).getByText("Tags saved.", { exact: true }),
  ).toBeVisible();

  await sample(page, "Analysis/pair-left.wav").click();
  await status(page, "Analysis unavailable");
  await inspector(page)
    .getByRole("button", { name: "Use as left", exact: true })
    .click();
  await sample(page, "Analysis/pair-right.wav").click();
  await status(page, "Analysis unavailable");
  await inspector(page)
    .getByRole("button", { name: "Use as right", exact: true })
    .click();
  await inspector(page)
    .getByRole("button", { name: "Confirm and check pair", exact: true })
    .click();
  await expect(
    inspector(page).getByText(
      "Stereo analysis is unavailable in this browser.",
    ),
  ).toBeVisible();

  const after = await snapshotFS(page);
  expect(after.sampleMetadata[AUDIO_MANIFEST_FILENAME]).toBeUndefined();
  expect(after.sampleMetadata[PAIR_MANIFEST_FILENAME]).toBeUndefined();
  expect(after.sampleMetadata["ravefold-tags.manifest.json"]).toContain(
    "still usable",
  );
  expect(after.audio).toEqual(before.audio);
  expect(after.settings).toEqual(before.settings);
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ local: [], session: [] });
  expect(errors).toEqual([]);
});
