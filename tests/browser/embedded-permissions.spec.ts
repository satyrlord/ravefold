import { expect, test, type Page } from "@playwright/test";
import { installFixtureFS } from "./fixture-fs.ts";

async function embeddedMenu(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installFixtureFS(page);
  // Simulate an allowed embed. The production preview rejects frame ancestors.
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      const headers = response.headers();
      headers["content-security-policy"] = headers[
        "content-security-policy"
      ]!.replace("frame-ancestors 'none'", "frame-ancestors 'self'");
      await route.fulfill({ response, headers });
    },
  );
  await page.route("**/embedded-menu", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<iframe title="Application" src="/" sandbox="allow-scripts allow-forms allow-same-origin allow-downloads" style="width:100%;height:900px;border:0"></iframe>',
    }),
  );
  await page.goto("/embedded-menu");
  const app = page.frameLocator("iframe");
  await expect(
    app.getByRole("button", { name: "New project", exact: true }),
  ).toBeVisible();
  const frame = page.frames().find((item) => item.parentFrame() !== null);
  if (!frame) throw new Error("The embedded application did not load.");
  return { app, frame, errors };
}

test("an embedded permission denial names the host limit and preserves files", async ({
  page,
}) => {
  const { app, frame, errors } = await embeddedMenu(page);
  await frame.evaluate(() =>
    window.fixtureFS.setPermission("settings", "denied"),
  );
  const before = await frame.evaluate(() => window.fixtureFS.snapshot());
  await app.getByRole("button", { name: "New project", exact: true }).click();
  await app
    .getByRole("button", { name: "Folder settings", exact: true })
    .click();
  const dialog = app.getByRole("dialog", {
    name: "Folder settings",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Select settings folder", exact: true })
    .click();
  await expect(
    dialog.getByText(/The host can restrict access in an embedded view/u),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Retry settings", exact: true })
    .click();
  await expect(dialog.getByText(/Use the host control/u)).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    app.getByRole("button", { name: "Enter tracker", exact: true }),
  ).toBeDisabled();
  const after = await frame.evaluate(() => window.fixtureFS.snapshot());
  expect(after.audio).toEqual(before.audio);
  expect(after.writes).toEqual(before.writes);
  expect(after.removals).toEqual(before.removals);
  expect(after.entries).toEqual([]);
  expect(errors).toEqual([]);
});

test("an embedded view with folder permission remains usable", async ({
  page,
}) => {
  const { app, errors } = await embeddedMenu(page);
  await app
    .getByRole("button", { name: "Folder settings", exact: true })
    .click();
  const dialog = app.getByRole("dialog", {
    name: "Folder settings",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Select settings folder", exact: true })
    .click();
  await expect(
    dialog.getByText("Settings folder is ready.", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText(/host can restrict access/u)).toHaveCount(0);
  expect(errors).toEqual([]);
});
