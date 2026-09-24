import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { parseAudioManifest } from "../../src/domain/audio-manifest.ts";
import {
  parsePreparationManifest,
  PREPARATION_MANIFEST_FILENAME,
} from "../../src/domain/preparation.ts";
import { installFixtureFS, snapshotFS } from "./fixture-fs.ts";

test.use({ contextOptions: { reducedMotion: "reduce" } });

const SOURCE = "Prepare/c-minor-135.wav";
const OUTPUT = "RaveFold prepared/Prepare/c-minor-135 180 BPM.wav";

async function start(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installFixtureFS(page, { preparationSamples: true });
  await page.goto("/");
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
  return errors;
}

function inspector(page: Page) {
  return page.getByRole("region", { name: "Sample inspector", exact: true });
}

function panel(page: Page) {
  return inspector(page).getByRole("region", {
    name: "Preparation",
    exact: true,
  });
}

async function select(page: Page, path: string) {
  await page.getByRole("button", { name: path, exact: true }).click();
}

async function planned(page: Page, path: string) {
  await select(page, path);
  await expect(inspector(page).locator(".sample-readiness")).toHaveText(
    "Needs conversion",
  );
  await expect(
    panel(page).getByRole("button", { name: "Prepare sample", exact: true }),
  ).toBeEnabled();
}

function phase(page: Page) {
  return panel(page).locator(".preparation-status");
}

test("a 135 BPM loop becomes a validated 180 BPM file while the interface stays usable", async ({
  page,
}) => {
  const errors = await start(page);
  const before = await snapshotFS(page);
  await planned(page, SOURCE);
  await expect(panel(page).getByText("180 BPM", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("None", { exact: true })).toBeVisible();
  await panel(page)
    .getByRole("button", { name: "Prepare sample", exact: true })
    .click();
  // The library stays usable during background preparation.
  await select(page, "Prepare/hits-135.wav");
  await expect(inspector(page).locator(".sample-readiness")).toHaveText(
    "Needs conversion",
  );
  await select(page, SOURCE);
  await expect(phase(page)).toHaveText(/^Ready\. Prepared at 180 BPM\.$/u, {
    timeout: 20_000,
  });
  await expect(panel(page).getByText(OUTPUT, { exact: true })).toBeVisible();
  await expect(
    inspector(page).getByRole("button", { name: "Play prepared", exact: true }),
  ).not.toHaveAttribute("aria-disabled", "true");
  const row = page.getByRole("button", { name: OUTPUT, exact: true });
  await expect(row).toBeVisible();
  await expect(
    page
      .getByRole("row")
      .filter({ has: page.getByRole("button", { name: SOURCE, exact: true }) })
      .getByText("Prepared", { exact: true }),
  ).toBeVisible();

  const after = await snapshotFS(page);
  for (const file of before.audio) expect(after.audio).toContainEqual(file);
  expect(after.audio.map((file) => file.path)).toContain(
    `Sample library/${OUTPUT}`,
  );
  const jobs = parsePreparationManifest(
    after.sampleMetadata[PREPARATION_MANIFEST_FILENAME]!,
  ).jobs;
  const job = Object.values(jobs)[0]!;
  expect(job.phase).toBe("ready");
  expect(job.output?.path).toBe(OUTPUT);
  expect(job.plan).toMatchObject({
    targetBpm: 180,
    beatCount: 8,
    semitones: 0,
  });
  const analysis = parseAudioManifest(
    after.sampleMetadata["ravefold-analysis.manifest.json"]!,
  );
  expect(analysis.samples[OUTPUT]?.measured.status).toBe("ready");
  expect(after.settings).toEqual(before.settings);
  const preparationWrites = after.writes.slice(before.writes.length);
  expect(preparationWrites.length).toBeGreaterThan(0);
  expect(
    preparationWrites.every(
      (write) =>
        write.path.startsWith("Sample library/") &&
        write.path.endsWith(".json"),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ local: [], session: [] });

  // The prepared file keeps its job tempo when the user selects it.
  await row.click();
  await expect(inspector(page).locator(".sample-readiness")).toHaveText(
    "Ready",
  );
  await expect(
    inspector(page).getByText("180 BPM", { exact: true }).first(),
  ).toBeVisible();
  expect(
    (
      await new AxeBuilder({ page })
        .include(".inspector-panel")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test("a minor phrase in D is transposed to C minor with a pitch change shown", async ({
  page,
}) => {
  const errors = await start(page);
  await planned(page, "Prepare/d-minor-90.wav");
  await expect(
    panel(page).getByText("Down 2 semitones", { exact: true }),
  ).toBeVisible();
  await panel(page)
    .getByRole("button", { name: "Prepare sample", exact: true })
    .click();
  await expect(phase(page)).toHaveText(
    "Ready. Prepared at 90 BPM with a -2 semitone shift.",
    { timeout: 20_000 },
  );
  await expect(
    panel(page).getByText(
      "RaveFold prepared/Prepare/d-minor-90 90 BPM -2 st.wav",
      { exact: true },
    ),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("cancellation during the write keeps partial audio, and retry uses a new path", async ({
  page,
}) => {
  const errors = await start(page);
  await planned(page, SOURCE);
  await page.evaluate(() => window.fixtureFS.blockAudioWrite());
  await panel(page)
    .getByRole("button", { name: "Prepare sample", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.fixtureFS.audioWriteStarted()), {
      timeout: 20_000,
    })
    .toBe(true);
  await panel(page)
    .getByRole("button", { name: "Cancel preparation", exact: true })
    .click();
  await page.evaluate(() => window.fixtureFS.releaseAudioWrite());
  await expect(phase(page)).toHaveText(/^Cancelled\./u);
  const cancelled = await snapshotFS(page);
  const partial = cancelled.audio.find(
    (file) => file.path === `Sample library/${OUTPUT}`,
  );
  expect(partial?.bytes).toBe(0);
  await panel(page)
    .getByRole("button", { name: "Retry preparation", exact: true })
    .click();
  await expect(phase(page)).toHaveText(/^Ready\./u, { timeout: 20_000 });
  await expect(
    panel(page).getByText(OUTPUT.replace(".wav", " (2).wav"), { exact: true }),
  ).toBeVisible();
  const done = await snapshotFS(page);
  expect(done.audio).toContainEqual(partial);
  for (const file of cancelled.audio) expect(done.audio).toContainEqual(file);
  expect(errors).toEqual([]);
});

test("insufficient disk space shows the failure and retry recovers", async ({
  page,
}) => {
  const errors = await start(page);
  const before = await snapshotFS(page);
  await planned(page, "Prepare/hits-135.wav");
  await page.evaluate(() =>
    window.fixtureFS.failAudioWrite("QuotaExceededError"),
  );
  await panel(page)
    .getByRole("button", { name: "Prepare sample", exact: true })
    .click();
  await expect(panel(page).getByRole("alert")).toHaveText(
    "Failed. The disk has insufficient space. Make space available, then retry.",
    { timeout: 20_000 },
  );
  const failed = await snapshotFS(page);
  for (const file of before.audio) expect(failed.audio).toContainEqual(file);
  await page.evaluate(() => window.fixtureFS.failAudioWrite(null));
  await panel(page)
    .getByRole("button", { name: "Retry preparation", exact: true })
    .click();
  await expect(phase(page)).toHaveText(/^Ready\./u, { timeout: 20_000 });
  const done = await snapshotFS(page);
  for (const file of failed.audio) expect(done.audio).toContainEqual(file);
  expect(errors).toEqual([]);
});

test("a changed source does not retain its old prepared label", async ({
  page,
}) => {
  const errors = await start(page);
  await planned(page, SOURCE);
  await panel(page)
    .getByRole("button", { name: "Prepare sample", exact: true })
    .click();
  await expect(phase(page)).toHaveText(/^Ready\./u, { timeout: 20_000 });
  const sourceRow = page.getByRole("row").filter({
    has: page.getByRole("button", { name: SOURCE, exact: true }),
  });
  await expect(sourceRow.getByText("Prepared", { exact: true })).toBeVisible();
  await page.evaluate(
    (path) => window.fixtureFS.changeSelectedAudio(path),
    SOURCE,
  );
  await planned(page, SOURCE);
  await expect(
    sourceRow.getByText("Needs conversion", { exact: true }),
  ).toBeVisible();
  await expect(sourceRow.getByText("Prepared", { exact: true })).toHaveCount(0);
  await select(page, "Prepare/hits-135.wav");
  await expect(sourceRow.getByText("Prepared", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("closing warns while the first preparation source read is pending", async ({
  page,
}) => {
  const errors = await start(page);
  await planned(page, SOURCE);
  await page.evaluate((path) => window.fixtureFS.holdAudioRead(path), SOURCE);
  await panel(page)
    .getByRole("button", { name: "Prepare sample", exact: true })
    .click();
  await expect(phase(page)).toHaveText("Analysis. Checking the source audio.");
  expect(
    await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await panel(page)
    .getByRole("button", { name: "Cancel preparation", exact: true })
    .click();
  await page.evaluate(() => window.fixtureFS.releaseAudioRead());
  await expect(phase(page)).toHaveText(/^Cancelled\./u);
  expect(errors).toEqual([]);
});

test("a preparation record failure stops work visibly and recovery preserves its output", async ({
  page,
}) => {
  const errors = await start(page);
  await planned(page, SOURCE);
  await page.evaluate(() => window.fixtureFS.blockAudioWrite());
  await panel(page)
    .getByRole("button", { name: "Prepare sample", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.fixtureFS.audioWriteStarted()), {
      timeout: 20_000,
    })
    .toBe(true);
  await page.evaluate(() => {
    window.fixtureFS.failTagWrite(true);
    window.fixtureFS.releaseAudioWrite();
  });
  await expect(phase(page)).toHaveText(/^Preparation stopped\./u, {
    timeout: 20_000,
  });
  await expect(panel(page).getByRole("alert")).toBeVisible();
  await expect(panel(page).getByRole("progressbar")).toHaveCount(0);
  const stopped = await snapshotFS(page);
  const output = stopped.audio.find(
    (file) => file.path === `Sample library/${OUTPUT}`,
  );
  expect(output?.bytes).toBeGreaterThan(0);
  await page.evaluate(() => window.fixtureFS.failTagWrite(false));
  await panel(page)
    .getByRole("button", { name: "Recover preparation", exact: true })
    .click();
  await expect(phase(page)).toHaveText(/^Ready\./u, { timeout: 20_000 });
  await expect(
    panel(page).getByText(OUTPUT.replace(".wav", " (2).wav"), { exact: true }),
  ).toBeVisible();
  const recovered = await snapshotFS(page);
  for (const file of stopped.audio)
    expect(recovered.audio).toContainEqual(file);
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a rejected WASM startup fails visibly and retry can prepare the sample", async ({
  page,
}) => {
  const errors = await start(page);
  await planned(page, SOURCE);
  const workerAsset = /\/prepare-worker-[^/]+\.js$/u;
  await page.route(workerAsset, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `WebAssembly.instantiate = async () => { throw new Error("Test WASM startup failure"); };\n${await response.text()}`,
    });
  });
  await panel(page)
    .getByRole("button", { name: "Prepare sample", exact: true })
    .click();
  await expect(phase(page)).toHaveText(
    "Failed. The preparation worker stopped. Retry preparation.",
    {
      timeout: 20_000,
    },
  );
  await page.unroute(workerAsset);
  await panel(page)
    .getByRole("button", { name: "Retry preparation", exact: true })
    .click();
  await expect(phase(page)).toHaveText(/^Ready\./u, { timeout: 20_000 });
  expect(errors).toEqual([]);
});
