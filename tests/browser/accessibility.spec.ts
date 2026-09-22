import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("menu and folder setup meet automated accessibility checks in each skin", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  for (let skin = 1; skin <= 6; skin++) {
    await page
      .getByRole("radio", { name: `Reference ${skin}`, exact: true })
      .click();
    for (const mode of ["dark", "light"]) {
      await page.getByLabel("Color mode", { exact: true }).selectOption(mode);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
    }
    await page
      .getByRole("button", { name: "Folder settings", exact: true })
      .click();
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.getByRole("button", { name: "Done", exact: true }).click();
  }
});

test("missing picker capability leaves the menu usable", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() =>
    Object.defineProperty(window, "showDirectoryPicker", { value: undefined }),
  );
  await page.goto("/");
  await expect(
    page.getByText("Folder access is unavailable.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Enter tracker", exact: true }),
  ).toBeDisabled();
  await page.getByRole("radio", { name: "Reference 5", exact: true }).click();
  await page
    .getByRole("button", { name: "Folder settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Select sample folder", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  expect(errors).toEqual([]);
});
