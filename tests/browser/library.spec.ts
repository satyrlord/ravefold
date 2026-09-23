import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { SKINS } from "../../src/skins/registry.ts";
import { projectFixture } from "../fixtures.ts";
import {
  installFixtureFS,
  snapshotFS,
  type FixtureOptions,
} from "./fixture-fs.ts";

interface AudioEvidence {
  decodes: number;
  hashes: string[];
  active: number;
  peak: number;
}

declare global {
  interface Window {
    fixtureAudio: AudioEvidence;
  }
}

test.use({ contextOptions: { reducedMotion: "reduce" } });

async function start(page: Page, options: FixtureOptions = {}) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installFixtureFS(page, { library: true, ...options });
  await page.addInitScript(() => {
    const evidence: AudioEvidence = {
      decodes: 0,
      hashes: [],
      active: 0,
      peak: 0,
    };
    window.fixtureAudio = evidence;
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (...args) {
      evidence.decodes++;
      void crypto.subtle.digest("SHA-256", args[0].slice(0)).then((digest) => {
        evidence.hashes.push(
          Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
        );
      });
      return Reflect.apply(decode, this, args);
    };
    const start = AudioBufferSourceNode.prototype.start;
    const stop = AudioBufferSourceNode.prototype.stop;
    const active = new Set<AudioBufferSourceNode>();
    AudioBufferSourceNode.prototype.start = function (...args) {
      const result = Reflect.apply(start, this, args);
      active.add(this);
      evidence.active = active.size;
      evidence.peak = Math.max(evidence.peak, active.size);
      this.addEventListener(
        "ended",
        () => {
          active.delete(this);
          evidence.active = active.size;
        },
        { once: true },
      );
      return result;
    };
    AudioBufferSourceNode.prototype.stop = function (...args) {
      const result = Reflect.apply(stop, this, args);
      active.delete(this);
      evidence.active = active.size;
      return result;
    };
  });
  await page.goto("/");
  return errors;
}

async function enter(page: Page, project?: ReturnType<typeof projectFixture>) {
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
  if (project) {
    await page.getByLabel("Project file", { exact: true }).setInputFiles({
      name: "library.ravefold.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
  } else {
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
  }
  await page
    .getByRole("button", { name: "Enter tracker", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Samples", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/^\d+ source files$/)).toBeVisible();
}

function sample(page: Page, path: string) {
  return page.getByRole("button", { name: path, exact: true });
}

function inspector(page: Page) {
  return page.getByRole("region", { name: "Sample inspector", exact: true });
}

async function addTag(page: Page, tag: string) {
  await inspector(page)
    .getByRole("textbox", { name: "New tag", exact: true })
    .fill(tag);
  await inspector(page)
    .getByRole("button", { name: "Add tag", exact: true })
    .click();
  await expect(
    inspector(page).getByText("Tags not saved.", { exact: true }),
  ).toBeVisible();
}

async function saveTag(page: Page) {
  await inspector(page)
    .getByRole("button", { name: "Save tags", exact: true })
    .click();
  await expect(
    inspector(page).getByText("Tags saved.", { exact: true }),
  ).toBeVisible();
}

test("duplicate names retain separate paths and source audio with one preview", async ({
  page,
}) => {
  const errors = await start(page);
  const before = await snapshotFS(page);
  await enter(page);
  await page
    .getByRole("button", { name: "Folder: Drums", exact: true })
    .click();
  await expect(sample(page, "Drums/kick.wav")).toBeVisible();
  await expect(sample(page, "Loops/kick.wav")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Folder: Loops", exact: true })
    .click();
  await expect(sample(page, "Loops/kick.wav")).toBeVisible();
  await expect(sample(page, "Drums/kick.wav")).toHaveCount(0);
  await page.getByRole("button", { name: "All samples", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search files or tags", exact: true })
    .fill("kick");
  await expect(sample(page, "Drums/kick.wav")).toBeVisible();
  await expect(sample(page, "Loops/kick.wav")).toBeVisible();
  await expect(sample(page, "Loops/acid.wav")).toHaveCount(0);
  expect(await page.evaluate(() => window.fixtureAudio.decodes)).toBe(0);
  for (const path of ["Drums/kick.wav", "Loops/kick.wav"]) {
    await sample(page, path).click();
    await inspector(page)
      .getByRole("button", { name: "Play source", exact: true })
      .click();
    const expectedHash = before.audio.find(
      (file) => file.path === `Sample library/${path}`,
    )!.hash;
    await expect
      .poll(() => page.evaluate(() => window.fixtureAudio.hashes))
      .toContain(expectedHash);
    await expect
      .poll(() => page.evaluate(() => window.fixtureAudio.active))
      .toBe(1);
    await expect(
      page.getByText("Source preview is playing.", { exact: false }),
    ).toBeVisible();
  }
  expect(await page.evaluate(() => window.fixtureAudio.peak)).toBe(1);
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.fixtureAudio.active))
    .toBe(0);
  await expect(
    page.getByRole("cell", { name: "ready", exact: true }),
  ).toHaveCount(0);
  expect((await snapshotFS(page)).audio).toEqual(before.audio);
  expect(errors).toEqual([]);
});

test("saved tags survive reload and filter the same file without audio or browser writes", async ({
  page,
}) => {
  const errors = await start(page);
  const before = await snapshotFS(page);
  await enter(page);
  await sample(page, "Loops/kick.wav").click();
  await addTag(page, "hard kick");
  await saveTag(page);
  const saved = await snapshotFS(page);
  expect(Object.values(saved.sampleMetadata).join("\n")).toContain("hard kick");
  expect(saved.audio).toEqual(before.audio);
  expect(saved.writes.every((write) => write.path.endsWith(".json"))).toBe(
    true,
  );
  await page.reload();
  await enter(page);
  await page
    .getByRole("combobox", { name: "Tag filter", exact: true })
    .selectOption({ label: "hard kick" });
  await expect(sample(page, "Loops/kick.wav")).toBeVisible();
  await expect(sample(page, "Drums/kick.wav")).toHaveCount(0);
  await expect(sample(page, "Loops/acid.wav")).toHaveCount(0);
  await page
    .getByRole("combobox", { name: "Tag filter", exact: true })
    .selectOption("");
  await page
    .getByRole("searchbox", { name: "Search files or tags", exact: true })
    .fill("hard kick");
  await expect(sample(page, "Loops/kick.wav")).toBeVisible();
  await expect(sample(page, "Drums/kick.wav")).toHaveCount(0);
  const after = await snapshotFS(page);
  expect(after.audio).toEqual(before.audio);
  expect(after.sampleMetadata).toEqual(saved.sampleMetadata);
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ local: [], session: [] });
  await sample(page, "Loops/kick.wav").click();
  await inspector(page)
    .getByRole("button", { name: "Remove tag: hard kick", exact: true })
    .click();
  await saveTag(page);
  await page.reload();
  await enter(page);
  await expect(
    page
      .getByRole("combobox", { name: "Tag filter", exact: true })
      .getByRole("option", { name: "hard kick", exact: true }),
  ).toHaveCount(0);
  await sample(page, "Loops/kick.wav").click();
  await expect(
    inspector(page).getByRole("button", {
      name: "Remove tag: hard kick",
      exact: true,
    }),
  ).toHaveCount(0);
  expect((await snapshotFS(page)).audio).toEqual(before.audio);
  expect(errors).toEqual([]);
});

test("empty filters reset and the inspector can close and reopen", async ({
  page,
}) => {
  const errors = await start(page);
  await enter(page);
  const search = page.getByRole("searchbox", {
    name: "Search files or tags",
    exact: true,
  });
  await search.fill("no matching sample");
  await expect(
    page.getByText("No files match these filters.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reset filters", exact: true })
    .click();
  await expect(search).toHaveValue("");
  await expect(sample(page, "Drums/kick.wav")).toBeVisible();
  await sample(page, "Loops/acid.wav").click();
  await inspector(page)
    .getByRole("button", { name: "Close inspector", exact: true })
    .click();
  await expect(inspector(page)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show inspector", exact: true })
    .click();
  await expect(
    inspector(page).getByRole("heading", { name: "acid.wav", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("unavailable Web Audio leaves sample selection and tag edits usable", async ({
  page,
}) => {
  const errors = await start(page);
  await enter(page);
  await page.evaluate(() =>
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: undefined,
    }),
  );
  await sample(page, "Drums/kick.wav").click();
  await inspector(page)
    .getByRole("button", { name: "Play source", exact: true })
    .click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Source preview is unavailable in this browser." }),
  ).toBeVisible();
  await sample(page, "Loops/acid.wav").click();
  await addTag(page, "lead");
  await saveTag(page);
  expect(await page.evaluate(() => window.fixtureAudio.decodes)).toBe(0);
  expect(errors).toEqual([]);
});

test("revoked folder access stops preview and preserves the project and unsaved tags through setup", async ({
  page,
}) => {
  const errors = await start(page);
  const project = projectFixture();
  await enter(page, project);
  const before = await snapshotFS(page);
  await sample(page, "Drums/kick.wav").click();
  await addTag(page, "keep this draft");
  await inspector(page)
    .getByRole("button", { name: "Play source", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.fixtureAudio.active))
    .toBe(1);
  await page.evaluate(() => {
    window.fixtureFS.setPermission("samples", "denied");
    window.dispatchEvent(new Event("focus"));
  });
  const dialog = page.getByRole("dialog", {
    name: "Folder settings",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole("main", { name: "Tracker workspace", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.fixtureAudio.active))
    .toBe(0);
  await expect(
    page.getByLabel("Selected project", { exact: true }),
  ).toContainText(project.name);
  await page.evaluate(() =>
    window.fixtureFS.setPermission("samples", "granted"),
  );
  await dialog
    .getByRole("button", { name: "Retry samples", exact: true })
    .click();
  await expect(
    dialog.getByText("Sample folder is ready.", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByRole("button", { name: "Enter tracker", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Samples", exact: true }),
  ).toBeVisible();
  const entries = (await snapshotFS(page)).entries;
  expect(entries).toHaveLength(2);
  expect(entries[0]?.project).toEqual(project);
  expect(entries[1]?.project).toEqual(project);
  await sample(page, "Drums/kick.wav").click();
  await expect(
    inspector(page).getByRole("button", {
      name: "Remove tag: keep this draft",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    inspector(page).getByText("Tags not saved.", { exact: true }),
  ).toBeVisible();
  expect((await snapshotFS(page)).sampleMetadata).toEqual(
    before.sampleMetadata,
  );
  await saveTag(page);
  expect(
    Object.values((await snapshotFS(page)).sampleMetadata).join("\n"),
  ).toContain("keep this draft");
  expect((await snapshotFS(page)).audio).toEqual(before.audio);
  expect(errors).toEqual([]);
});

test("a denied tag commit retains the last valid record and permits retry", async ({
  page,
}) => {
  const errors = await start(page);
  await enter(page);
  await sample(page, "Drums/kick.wav").click();
  await addTag(page, "drum");
  await saveTag(page);
  const before = await snapshotFS(page);
  await page.evaluate(() => window.fixtureFS.failTagWrite(true));
  await addTag(page, "hard");
  await inspector(page)
    .getByRole("button", { name: "Save tags", exact: true })
    .click();
  await expect(
    inspector(page).getByText("Tags not saved.", { exact: true }),
  ).toBeVisible();
  const retry = inspector(page).getByRole("button", {
    name: "Retry tag save",
    exact: true,
  });
  await expect(retry).toBeVisible();
  const failed = await snapshotFS(page);
  expect(failed.sampleMetadata).toEqual(before.sampleMetadata);
  expect(failed.audio).toEqual(before.audio);
  await page.evaluate(() => window.fixtureFS.failTagWrite(false));
  await retry.click();
  await expect(
    inspector(page).getByText("Tags saved.", { exact: true }),
  ).toBeVisible();
  expect(
    Object.values((await snapshotFS(page)).sampleMetadata).join("\n"),
  ).toContain("hard");
  expect(errors).toEqual([]);
});

test("a large catalog is searchable before any audio decoding", async ({
  page,
}, testInfo) => {
  const errors = await start(page, { extraSamples: 1200 });
  const began = Date.now();
  await enter(page);
  await page
    .getByRole("searchbox", { name: "Search files or tags", exact: true })
    .fill("sample-1199");
  await expect(sample(page, "Catalog/sample-1199.wav")).toBeVisible();
  expect(await page.evaluate(() => window.fixtureAudio.decodes)).toBe(0);
  testInfo.annotations.push({
    type: "catalog-measurement",
    description: `Chromium, 1203 generated WAV files; folder setup, tracker entry and last-file search took ${Date.now() - began} ms. No audio decode calls.`,
  });
  expect(errors).toEqual([]);
});

test("search, tags, preview and waveform support keyboard commands", async ({
  page,
}) => {
  const errors = await start(page);
  await enter(page);
  const search = page.getByRole("searchbox", {
    name: "Search files or tags",
    exact: true,
  });
  await search.focus();
  await page.keyboard.type("acid");
  await expect(search).toBeFocused();
  await sample(page, "Loops/acid.wav").focus();
  await page.keyboard.press("Enter");
  const tag = inspector(page).getByRole("textbox", {
    name: "New tag",
    exact: true,
  });
  await tag.focus();
  await page.keyboard.type("lead");
  await page.keyboard.press("Tab");
  await expect(
    inspector(page).getByRole("button", { name: "Add tag", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await inspector(page)
    .getByRole("button", { name: "Save tags", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    inspector(page).getByText("Tags saved.", { exact: true }),
  ).toBeVisible();
  const play = inspector(page).getByRole("button", {
    name: "Play source",
    exact: true,
  });
  await play.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.fixtureAudio.active))
    .toBe(1);
  const stop = page.getByRole("button", { name: "Stop preview", exact: true });
  await stop.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.fixtureAudio.active))
    .toBe(0);
  const waveform = inspector(page).getByRole("button", {
    name: "Show waveform",
    exact: true,
  });
  await waveform.focus();
  await page.keyboard.press("Enter");
  await expect(
    inspector(page).getByRole("img", { name: /waveform/i }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.fixtureAudio.active)).toBe(0);
  expect(errors).toEqual([]);
});

test("all tracker skins pass accessibility checks and keep controls reachable at desktop and compact sizes", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = await start(page);
  await enter(page);
  for (const skin of SKINS) {
    for (const mode of ["dark", "light"]) {
      await page
        .getByRole("button", { name: "Back to menu", exact: true })
        .click();
      await page.getByRole("radio", { name: skin.label, exact: true }).click();
      await page.getByLabel("Color mode", { exact: true }).selectOption(mode);
      await page
        .getByRole("button", { name: "Enter tracker", exact: true })
        .click();
      await sample(page, "Drums/kick.wav").click();
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      if (mode === "light") continue;
      for (const size of [
        { width: 1440, height: 960 },
        { width: 1280, height: 720 },
        { width: 640, height: 360 },
      ]) {
        await page.setViewportSize(size);
        const search = page.getByRole("searchbox", {
          name: "Search files or tags",
          exact: true,
        });
        await search.focus();
        await expect(search).toBeInViewport();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        ).toBe(true);
        if (size.width === 1280) {
          const libraryBounds = await page
            .getByRole("region", { name: "Sample library", exact: true })
            .boundingBox();
          const previewBounds = await page
            .getByRole("button", { name: "Stop preview", exact: true })
            .boundingBox();
          const mixerBounds = await page
            .getByRole("region", { name: "Mixer", exact: true })
            .boundingBox();
          expect(libraryBounds).not.toBeNull();
          expect(previewBounds).not.toBeNull();
          expect(mixerBounds).not.toBeNull();
          expect(previewBounds!.y).toBeGreaterThanOrEqual(libraryBounds!.y);
          expect(previewBounds!.y + previewBounds!.height).toBeLessThanOrEqual(
            libraryBounds!.y + libraryBounds!.height + 1,
          );
          expect(libraryBounds!.y + libraryBounds!.height).toBeLessThanOrEqual(
            mixerBounds!.y + 1,
          );
        }
        await page.screenshot({
          path: `.impeccable/review/tracker-${skin.id}-${size.width}x${size.height}.png`,
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 1440, height: 960 });
    }
  }
  expect(errors).toEqual([]);
});
