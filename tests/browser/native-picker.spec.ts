import { expect, test } from "@playwright/test";

test.use({ contextOptions: { reducedMotion: "reduce" } });

for (const folder of ["sample", "settings"] as const) {
  test(`native ${folder} picker cancellation leaves the menu usable`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    testInfo.annotations.push({
      type: "evidence-limit",
      description:
        "Native cancellation only. Successful folder selection and grant revocation require separate native evidence.",
    });
    await page.goto("/");
    const nativePicker = await page.evaluate(() => {
      const picker = (window as Window & { showDirectoryPicker?: unknown })
        .showDirectoryPicker;
      return (
        typeof picker === "function" &&
        Function.prototype.toString.call(picker).includes("[native code]")
      );
    });
    expect(
      nativePicker,
      "The test requires the unmodified browser folder picker.",
    ).toBe(true);
    await expect(
      page.getByText("Folder selection cancelled.", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Folder settings", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Folder settings",
      exact: true,
    });
    await page
      .getByRole("button", { name: `Select ${folder} folder`, exact: true })
      .click();
    await expect(
      dialog.getByText("Folder selection cancelled.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: `Select ${folder} folder`,
        exact: true,
      }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Enter tracker", exact: true }),
    ).toBeDisabled();
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(() => ({
        local: localStorage.length,
        session: sessionStorage.length,
      })),
    ).toEqual({ local: 0, session: 0 });
  });
}
