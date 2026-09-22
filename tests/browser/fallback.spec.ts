import { expect, test } from "@playwright/test";

test("an unsupported browser opens the static menu without application errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(
    page.getByText("Folder access is unavailable.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Enter tracker", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Effects", { exact: true })).toHaveValue(
    "static",
  );
  for (let index = 1; index <= 6; index++) {
    await page
      .getByRole("radio", { name: `Reference ${index}`, exact: true })
      .click();
  }
  await page
    .getByRole("button", { name: "Folder settings", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Select sample folder", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  expect(errors).toEqual([]);
});

test("an unsupported browser keeps the full-effects menu usable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const root = page.locator(".material-root");
  await expect(root).toHaveAttribute("data-effects", "full");
  await page.getByRole("radio", { name: "Reference 6", exact: true }).click();
  await expect(root).toHaveAttribute("data-skin", "reference-6");
  await page
    .getByRole("button", { name: "Folder settings", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const renderer = await root.getAttribute("data-renderer");
  expect(["material", "unavailable"]).toContain(renderer);
  await expect(page.locator("canvas")).toHaveCount(
    renderer === "material" ? 1 : 0,
  );
  expect(errors).toEqual([]);
});
