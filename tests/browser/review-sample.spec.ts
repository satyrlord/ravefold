import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { parseAudioManifest } from "../../src/domain/audio-manifest.ts";
import {
  parsePreparationManifest,
  PREPARATION_MANIFEST_FILENAME,
} from "../../src/domain/preparation.ts";
import { installFixtureFS, snapshotFS } from "./fixture-fs.ts";

test.use({ contextOptions: { reducedMotion: "reduce" } });

const MIXED = "Review/mixed-key.wav";
const AMBIGUOUS = "Review/ambiguous-180.wav";
const OUTPUT =
  "RaveFold prepared/Review/mixed-key section 0.000-1.333 s 180 BPM.wav";
const ANALYSIS = "ravefold-analysis.manifest.json";

async function start(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installFixtureFS(page, { reviewSamples: true });
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

function review(page: Page) {
  return inspector(page).getByRole("region", { name: "Review", exact: true });
}

function readiness(page: Page) {
  return inspector(page).locator(".sample-readiness");
}

function result(page: Page) {
  return review(page).locator(".review-status");
}

/** The accessible label of the focused control. */
function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const element = document.activeElement as HTMLInputElement | null;
    if (!element) return "";
    return (
      element.getAttribute("aria-label") ??
      element.labels?.[0]?.textContent ??
      element.textContent ??
      ""
    ).trim();
  });
}

/** Move focus with the Tab key only. */
async function tabTo(page: Page, name: string): Promise<void> {
  for (let step = 0; step < 80; step++) {
    if ((await focusedName(page)) === name) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`The Tab key did not reach ${name}.`);
}

test("S005-AC01, AC03, AC06, AC07: a keyboard user prepares a compatible section of mixed-key audio", async ({
  page,
}) => {
  const errors = await start(page);
  const before = await snapshotFS(page);
  await page.getByRole("button", { name: MIXED, exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(readiness(page)).toHaveText("Needs review");
  await expect(review(page).getByText(/^Reason for review: /u)).toBeVisible();
  await expect(
    review(page).getByText("Rhythm score", { exact: true }),
  ).toBeVisible();
  await expect(result(page)).toHaveText("No corrected input is recorded.");
  await expect(
    inspector(page).getByRole("button", { name: "Play source", exact: true }),
  ).toBeEnabled();

  await tabTo(page, "Region start");
  await page.keyboard.type("0");
  await page.keyboard.press("Tab");
  expect(await focusedName(page)).toBe("Region end");
  await page.keyboard.type("1.3333333333");
  await tabTo(page, "Validate again");
  await page.keyboard.press("Enter");
  await expect(result(page)).toHaveText(/^Ready\. /u);
  await expect(result(page)).toHaveAttribute("role", "status");
  await expect(
    review(page).getByText("Validated input: section 0.000–1.333 s.", {
      exact: true,
    }),
  ).toBeVisible();
  // The section result does not make the source ready.
  await expect(readiness(page)).toHaveText("Needs review");
  await expect(
    review(page).getByText("Section 0.000–1.333 s", { exact: true }),
  ).toBeVisible();

  await tabTo(page, "Prepare section");
  await page.keyboard.press("Enter");
  await expect(review(page).locator(".preparation-status")).toHaveText(
    /^Ready\. Prepared at 180 BPM\.$/u,
    { timeout: 20_000 },
  );
  await expect(review(page).getByText(OUTPUT, { exact: true })).toBeVisible();
  await tabTo(page, "Play prepared section");
  expect(
    (
      await new AxeBuilder({ page })
        .include(".inspector-panel")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);

  const after = await snapshotFS(page);
  for (const file of before.audio) expect(after.audio).toContainEqual(file);
  const added = after.audio.filter(
    (file) => !before.audio.some((item) => item.path === file.path),
  );
  expect(added.map((file) => file.path)).toEqual([`Sample library/${OUTPUT}`]);
  const analysis = parseAudioManifest(after.sampleMetadata[ANALYSIS]!);
  const source = analysis.samples[MIXED]!;
  expect(source.measured.status).toBe("needs-review");
  expect(source.corrected).toEqual({
    bpm: null,
    key: null,
    tonalClass: null,
    region: { startFrame: 0, endFrameExclusive: 64_000 },
  });
  expect(source.reviewed?.status).toBe("ready");
  expect(analysis.samples[OUTPUT]?.measured.status).toBe("ready");
  const job = Object.values(
    parsePreparationManifest(
      after.sampleMetadata[PREPARATION_MANIFEST_FILENAME]!,
    ).jobs,
  )[0]!;
  expect(job.plan.region).toEqual({ startFrame: 0, endFrameExclusive: 64_000 });
  expect(job.output?.path).toBe(OUTPUT);
  expect(
    after.writes
      .slice(before.writes.length)
      .every(
        (write) =>
          write.path.startsWith("Sample library/") &&
          write.path.endsWith(".json"),
      ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("S005-AC04: an incompatible or empty region stays out of preparation", async ({
  page,
}) => {
  const errors = await start(page);
  await page.getByRole("button", { name: MIXED, exact: true }).click();
  await expect(readiness(page)).toHaveText("Needs review");
  const regionStart = review(page).getByLabel("Region start", { exact: true });
  const regionEnd = review(page).getByLabel("Region end", { exact: true });
  const validate = review(page).getByRole("button", {
    name: "Validate again",
    exact: true,
  });
  await regionStart.fill("1.3333333333");
  await regionEnd.fill("2.6666666667");
  await validate.click();
  await expect(result(page)).toHaveText(/^Needs review\. .*C-minor form/u);
  await expect(
    review(page).getByText(
      "This section needs review. It cannot be prepared.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    review(page).getByRole("button", { name: "Prepare section", exact: true }),
  ).toHaveCount(0);

  const before = await snapshotFS(page);
  await regionStart.fill("1");
  await regionEnd.fill("1");
  await validate.click();
  await expect(result(page)).toHaveText("Input not sent. The region is empty.");
  await expect(result(page)).toHaveAttribute("role", "alert");
  await regionEnd.fill("");
  await validate.click();
  await expect(
    review(page).getByText("Enter the start and the end of the region.", {
      exact: true,
    }),
  ).toBeVisible();
  const after = await snapshotFS(page);
  expect(after.audio).toEqual(before.audio);
  expect(after.writes).toEqual(before.writes);
  expect(errors).toEqual([]);
});

test("S005-AC02: a corrected tempo is saved apart from the detector result", async ({
  page,
}) => {
  const errors = await start(page);
  await page.getByRole("button", { name: AMBIGUOUS, exact: true }).click();
  await expect(readiness(page)).toHaveText("Needs review");
  await expect(
    inspector(page)
      .getByText(/both 90 and 180 BPM/u)
      .first(),
  ).toBeVisible();
  const tempo = review(page).getByLabel("Source tempo (BPM)", { exact: true });
  await tempo.fill("90");
  await review(page)
    .getByRole("button", { name: "Validate again", exact: true })
    .click();
  await expect(result(page)).toHaveText(/^Ready\. .*correction agrees/u);
  await expect(readiness(page)).toHaveText("Ready");
  await expect(
    inspector(page).getByText("User corrections: 90 BPM, whole source.", {
      exact: true,
    }),
  ).toBeVisible();
  const analysis = parseAudioManifest(
    (await snapshotFS(page)).sampleMetadata[ANALYSIS]!,
  );
  const saved = analysis.samples[AMBIGUOUS]!;
  expect(saved.measured.status).toBe("needs-review");
  expect(saved.corrected?.bpm).toBe(90);
  expect(saved.reviewed?.measured.bpm).toBe(90);

  // Another selection validates the saved correction again.
  await page.getByRole("button", { name: MIXED, exact: true }).click();
  await expect(readiness(page)).toHaveText("Needs review");
  await page.getByRole("button", { name: AMBIGUOUS, exact: true }).click();
  await expect(readiness(page)).toHaveText("Ready");
  await expect(tempo).toHaveValue("90");

  await review(page)
    .getByRole("button", { name: "Clear corrections", exact: true })
    .click();
  await expect(readiness(page)).toHaveText("Needs review");
  await expect(result(page)).toHaveText("No corrected input is recorded.");
  await expect(tempo).toHaveValue("");
  expect(errors).toEqual([]);
});
