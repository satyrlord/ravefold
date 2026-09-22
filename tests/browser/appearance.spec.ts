import { expect, test, type Page } from "@playwright/test";

const reviewFolder = ".impeccable/review";

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

for (let skin = 1; skin <= 6; skin += 1) {
  test(`reference ${skin} has complete material, static and theme states`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors = watchErrors(page);
    await page.emulateMedia({
      colorScheme: "dark",
      reducedMotion: "no-preference",
    });
    await page.goto("/");
    const root = page.locator(".material-root");
    const selection = page.getByRole("radio", {
      name: `Reference ${skin}`,
      exact: true,
    });
    await selection.click();
    await expect(selection).toHaveAttribute("aria-checked", "true");
    await expect(root).toHaveAttribute("data-skin", `reference-${skin}`);

    for (const mode of ["dark", "light", "system"] as const) {
      await page.getByLabel("Color mode", { exact: true }).selectOption(mode);
      await expect(root).toHaveAttribute(
        "data-mode",
        mode === "system" ? "dark" : mode,
      );
      for (const effects of ["full", "reduced", "static"] as const) {
        await page.getByLabel("Effects", { exact: true }).selectOption(effects);
        await expect(root).toHaveAttribute("data-effects", effects);
        await expect(root).toHaveAttribute(
          "data-renderer",
          effects === "static" ? "static" : "material",
        );
        await expect(page.locator("canvas")).toHaveCount(
          effects === "static" ? 0 : 1,
        );
        await expect(
          page.getByRole("button", { name: "New project", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Open project", exact: true }),
        ).toBeVisible();
        if (effects !== "static") {
          await expect
            .poll(() =>
              page
                .locator("canvas")
                .evaluate(
                  (canvas: HTMLCanvasElement) => canvas.width * canvas.height,
                ),
            )
            .toBeGreaterThan(0);
          await expect(page.locator(".material-proxy").first()).toBeAttached();
        }
        if (
          (mode === "dark" && effects === "full") ||
          (mode === "light" && effects === "static")
        ) {
          await page.screenshot({
            path: `${reviewFolder}/reference-${skin}-${mode}-${effects}.png`,
            fullPage: true,
          });
        }
      }
    }
    expect(errors).toEqual([]);
  });
}

test("reduced motion starts without a material canvas", async ({ page }) => {
  const errors = watchErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".material-root")).toHaveAttribute(
    "data-effects",
    "static",
  );
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.getByLabel("Effects", { exact: true })).toHaveValue(
    "static",
  );
  expect(errors).toEqual([]);
});

test("unavailable graphics retain the full usable menu", async ({ page }) => {
  const errors = watchErrors(page);
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: function (
        this: HTMLCanvasElement,
        type: string,
        ...args: unknown[]
      ) {
        return type === "webgl2"
          ? null
          : Reflect.apply(original, this, [type, ...args]);
      },
    });
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  await expect(page.locator(".material-root")).toHaveAttribute(
    "data-renderer",
    "unavailable",
  );
  await expect(page.locator("canvas")).toHaveCount(0);
  for (let skin = 1; skin <= 6; skin += 1) {
    await page
      .getByRole("radio", { name: `Reference ${skin}`, exact: true })
      .click();
    await expect(page.locator(".material-root")).toHaveAttribute(
      "data-skin",
      `reference-${skin}`,
    );
    await expect(
      page.getByRole("button", { name: "Folder settings", exact: true }),
    ).toBeEnabled();
  }
  expect(errors).toEqual([]);
});

test("material loss and theme changes keep dialog controls mounted and focused", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.emulateMedia({
    colorScheme: "dark",
    reducedMotion: "no-preference",
  });
  await page.goto("/");
  await page.getByLabel("Color mode", { exact: true }).selectOption("system");
  const open = page.getByRole("button", {
    name: "Folder settings",
    exact: true,
  });
  await open.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const focused = await page.locator(":focus").elementHandle();
  expect(focused).not.toBeNull();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator(".material-root")).toHaveAttribute(
    "data-mode",
    "light",
  );
  expect(
    await focused!.evaluate(
      (node) => node.isConnected && node === document.activeElement,
    ),
  ).toBe(true);
  await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("webgl2");
    const extension = context?.getExtension("WEBGL_lose_context");
    if (!extension)
      throw new Error("The context-loss test requires its WebGL extension.");
    extension.loseContext();
  });
  await expect(page.locator(".material-root")).toHaveAttribute(
    "data-renderer",
    "unavailable",
  );
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(
    await focused!.evaluate(
      (node) => node.isConnected && node === document.activeElement,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${reviewFolder}/dialog-keyboard-fallback.png`,
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  if (await dialog.isVisible()) await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(open).toBeFocused();
  expect(errors).toEqual([]);
});

test("all skins keep entry and folder controls reachable at the 200 percent layout size", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 640, height: 360 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  for (let skin = 1; skin <= 6; skin += 1) {
    await page
      .getByRole("radio", { name: `Reference ${skin}`, exact: true })
      .click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    const open = page.getByRole("button", {
      name: "Folder settings",
      exact: true,
    });
    await open.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page.locator(":focus")).toBeInViewport();
    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.press("Tab");
      await expect(page.locator(":focus")).toBeInViewport();
      expect(
        await page
          .locator(":focus")
          .evaluate((node) => Boolean(node.closest('dialog,[role="dialog"]'))),
      ).toBe(true);
    }
    await page.screenshot({
      path: `${reviewFolder}/reference-${skin}-compact-dialog.png`,
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    if (await dialog.isVisible()) await page.keyboard.press("Escape");
    await expect(open).toBeFocused();
  }
  expect(errors).toEqual([]);
});
