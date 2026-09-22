import { expect, test, type Locator, type Page } from "@playwright/test";
import { installFixtureFS } from "./fixture-fs.ts";

const sampleTip = "Select your WAV folder. Existing audio stays unchanged.";
const settingsTip = "Store settings in a dedicated folder inside Documents.";

async function openFolders(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await installFixtureFS(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Folder settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Folder settings",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectUnclipped(page: Page, tooltip: Locator) {
  await expect(tooltip).toBeVisible();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  await expect
    .poll(async () => {
      const bounds = await tooltip.boundingBox();
      return Boolean(
        bounds &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= viewport!.width &&
        bounds.y + bounds.height <= viewport!.height,
      );
    })
    .toBe(true);
  expect(
    await tooltip.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const points = [
        [bounds.left + 8, bounds.top + 8],
        [bounds.right - 8, bounds.top + 8],
        [bounds.left + 8, bounds.bottom - 8],
        [bounds.right - 8, bounds.bottom - 8],
        [bounds.left + bounds.width / 2, bounds.top + bounds.height / 2],
      ];
      return points.every(([x, y]) =>
        node.contains(document.elementFromPoint(x!, y!)),
      );
    }),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
}

test("pointer exit hides tooltips after clicks and modal autofocus", async ({
  page,
}) => {
  const dialog = await openFolders(page);
  const close = dialog.getByRole("button", { name: "Close dialog" });
  await expect(close).toBeFocused();
  await dialog.getByRole("heading", { name: "Folder settings" }).hover();
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  const select = dialog.getByRole("button", {
    name: "Select sample folder",
    exact: true,
  });
  await select.hover();
  await expect(page.getByRole("tooltip")).toHaveText(sampleTip);
  await select.click();
  await expect(select).toBeFocused();
  await expect(dialog.getByText("Sample folder is ready.")).toBeVisible();
  await dialog.getByRole("heading", { name: "Folder settings" }).hover();
  await expect(select).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("heading", { name: "Make your next track." }).hover();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test("keyboard tooltips support Escape and disappear after focus moves", async ({
  page,
}) => {
  const dialog = await openFolders(page);
  await dialog.getByRole("heading", { name: "Folder settings" }).hover();
  await page.keyboard.press("Tab");
  const sample = dialog.getByRole("button", {
    name: "Select sample folder",
    exact: true,
  });
  await expect(sample).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveText(sampleTip);
  await sample.hover();
  await dialog.getByRole("heading", { name: "Folder settings" }).hover();
  await page.waitForTimeout(200);
  await expect(page.getByRole("tooltip")).toHaveText(sampleTip);
  await expectUnclipped(page, page.getByRole("tooltip"));
  await page.screenshot({
    path: ".impeccable/review/tooltips-keyboard.png",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(sample).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Select settings folder", exact: true }),
  ).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveText(settingsTip);
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeFocused();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test("one tooltip remains visible while the pointer moves onto its text", async ({
  page,
}) => {
  const dialog = await openFolders(page);
  const sample = dialog.getByRole("button", {
    name: "Select sample folder",
    exact: true,
  });
  await sample.hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveText(sampleTip);
  await tooltip.hover();
  await page.waitForTimeout(300);
  await expect(tooltip).toHaveText(sampleTip);
  await dialog.getByRole("heading", { name: "Folder settings" }).hover();
  await expect(tooltip).toHaveCount(0);

  await sample.hover();
  await expect(tooltip).toHaveText(sampleTip);
  await dialog
    .getByRole("button", { name: "Select settings folder", exact: true })
    .hover();
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toHaveText(settingsTip);
  await dialog.getByRole("button", { name: "Close dialog" }).hover();
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toHaveText("Close this window.");
  await dialog.getByRole("heading", { name: "Folder settings" }).hover();
  await expect(tooltip).toHaveCount(0);
});

for (const viewport of [
  { width: 620, height: 666, screenshot: "folder" },
  { width: 640, height: 360, screenshot: "narrow" },
]) {
  test(`tooltips remain visible inside the ${viewport.width} by ${viewport.height} viewport`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const dialog = await openFolders(page);
    const tooltip = page.getByRole("tooltip");

    await dialog.getByRole("button", { name: "Close dialog" }).hover();
    await expect(tooltip).toHaveText("Close this window.");
    await expectUnclipped(page, tooltip);

    await dialog
      .getByRole("button", { name: "Select sample folder", exact: true })
      .hover();
    await expect(tooltip).toHaveText(sampleTip);
    await expectUnclipped(page, tooltip);
    await page.screenshot({
      path: `.impeccable/review/tooltips-${viewport.screenshot}.png`,
    });

    await dialog
      .getByRole("button", { name: "Select settings folder", exact: true })
      .hover();
    await expect(tooltip).toHaveText(settingsTip);
    await expectUnclipped(page, tooltip);
    if (viewport.height === 360) {
      expect(await dialog.evaluate((node) => node.scrollTop)).toBeGreaterThan(
        0,
      );
    }
    await page.screenshot({
      path: `.impeccable/review/tooltips-${viewport.screenshot}-settings.png`,
    });
    await dialog.getByRole("button", { name: "Done", exact: true }).hover();
    await expect(tooltip).toHaveCount(0);
  });
}
