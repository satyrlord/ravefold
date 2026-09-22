import { expect, test, type Page } from "@playwright/test";
import { projectFixture, settingsFixture } from "../fixtures.ts";
import {
  installFixtureFS,
  snapshotFS,
  type FixtureOptions,
} from "./fixture-fs.ts";

async function start(page: Page, options: FixtureOptions = {}) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installFixtureFS(page, options);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "New project", exact: true }),
  ).toBeVisible();
  return errors;
}

async function folders(page: Page, samples = true, settings = true) {
  await page
    .getByRole("button", { name: "Folder settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Folder settings",
    exact: true,
  });
  if (samples) {
    await dialog
      .getByRole("button", { name: "Select sample folder", exact: true })
      .click();
    await expect(
      dialog.getByText("Sample folder is ready.", { exact: true }),
    ).toBeVisible();
  }
  if (settings) {
    await dialog
      .getByRole("button", { name: "Select settings folder", exact: true })
      .click();
    await expect(
      dialog.getByText("Settings folder is ready.", { exact: true }),
    ).toBeVisible();
  }
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
}

async function upload(page: Page, value: unknown) {
  await page.getByLabel("Project file", { exact: true }).setInputFiles({
    name: "fixture.ravefold.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      typeof value === "string" ? value : JSON.stringify(value),
    ),
  });
}

test("both folders allow one new-project entry and preserve every audio byte", async ({
  page,
}) => {
  const errors = await start(page);
  const before = await snapshotFS(page);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Enter tracker", exact: true }),
  ).toBeDisabled();
  await folders(page, true, false);
  await expect(
    page.getByRole("button", { name: "Enter tracker", exact: true }),
  ).toBeDisabled();
  await folders(page, false, true);
  await expect(
    page.getByRole("button", { name: "Enter tracker", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Enter tracker", exact: true })
    .dblclick();
  await expect(
    page.getByRole("heading", { name: "Project ready", exact: true }),
  ).toBeVisible();
  const after = await snapshotFS(page);
  expect(after.entries).toHaveLength(1);
  expect(after.entries[0]?.mode).toBe("new");
  expect(after.entries[0]?.project.clips).toEqual([]);
  expect(after.audio).toEqual(before.audio);
  expect(after.writes.every((item) => item.path.endsWith(".json"))).toBe(true);
  expect(
    after.removals.every((path) =>
      /\.ravefold-access-[\da-f-]+\.manifest\.json$/.test(path),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ local: [], session: [] });
  expect(errors).toEqual([]);
});

test("Open rejects invalid documents and keeps valid missing-sample positions", async ({
  page,
}) => {
  const errors = await start(page);
  const project = projectFixture();
  await upload(page, project);
  const selected = page.getByLabel("Selected project", { exact: true });
  await expect(selected).toContainText(project.name);
  await upload(page, "{broken");
  await expect(
    page.getByText("The project file is not valid JSON.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(selected).toContainText(project.name);
  await upload(page, { ...project, schemaVersion: 99 });
  await expect(selected).toContainText(project.name);
  await upload(page, { ...project, audio: "embedded bytes" });
  await expect(selected).toContainText(project.name);
  await folders(page);
  await page
    .getByRole("button", { name: "Enter tracker", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Project ready", exact: true }),
  ).toBeVisible();
  const entry = (await snapshotFS(page)).entries[0]!;
  expect(entry.mode).toBe("open");
  expect(entry.project).toEqual(project);
  expect(entry.missingSamples).toEqual([
    {
      clipId: "clip-bass",
      trackId: "track-bass",
      samplePath: "Bass/missing.wav",
      startTick: 3840,
      durationTicks: 3840,
    },
  ]);
  expect(errors).toEqual([]);
});

test("recovery cancellation and selection do not change recovery files", async ({
  page,
}) => {
  const recovered = { ...projectFixture(), name: "Recovered arrangement" };
  const files = {
    "take.ravefold.json": JSON.stringify(recovered),
    "broken.ravefold.json": "broken",
  };
  const errors = await start(page, { recovery: files });
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const selected = page.getByLabel("Selected project", { exact: true });
  await folders(page);
  const original = await selected.textContent();
  const recover = page.getByRole("button", {
    name: "Recovery copies (1)",
    exact: true,
  });
  await recover.click();
  const dialog = page.getByRole("dialog", {
    name: "Recovery copies",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(selected).toHaveText(original!);
  expect((await snapshotFS(page)).recovery).toEqual(files);
  await recover.click();
  await dialog
    .getByRole("button", { name: "Use recovery", exact: true })
    .click();
  await expect(selected).toContainText(recovered.name);
  await page
    .getByRole("button", { name: "Enter tracker", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Project ready", exact: true }),
  ).toBeVisible();
  const after = await snapshotFS(page);
  expect(after.entries[0]?.mode).toBe("recover");
  expect(after.entries[0]?.project).toEqual(recovered);
  expect(after.recovery).toEqual(files);
  expect(after.writes.some((item) => item.path.includes("/recovery/"))).toBe(
    false,
  );
  expect(errors).toEqual([]);
});

for (const kind of ["samples", "settings"] as const) {
  test(`revoked ${kind} access prevents entry and permits retry`, async ({
    page,
  }) => {
    const errors = await start(page);
    await folders(page);
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    await page.evaluate(
      (folderKind) => window.fixtureFS.setPermission(folderKind, "denied"),
      kind,
    );
    await page
      .getByRole("button", { name: "Enter tracker", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Enter tracker", exact: true }),
    ).toBeDisabled();
    expect((await snapshotFS(page)).entries).toEqual([]);
    await page.evaluate(
      (folderKind) => window.fixtureFS.setPermission(folderKind, "granted"),
      kind,
    );
    await page
      .getByRole("button", { name: "Folder settings", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: `Retry ${kind}`, exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Done", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Enter tracker", exact: true }),
    ).toBeEnabled();
    expect(errors).toEqual([]);
  });
}

test("unavailable persistence keeps the session usable without fallback storage", async ({
  page,
}) => {
  const errors = await start(page, { unavailablePersistence: true });
  await folders(page);
  await expect(
    page.getByText(
      "Folder references cannot be saved. Select folders again next session.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page
    .getByRole("button", { name: "Enter tracker", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Project ready", exact: true }),
  ).toBeVisible();
  expect((await snapshotFS(page)).entries).toHaveLength(1);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(errors).toEqual([]);
});

test("appearance uses explicit session choices and saves merged settings", async ({
  page,
}) => {
  const settings = settingsFixture();
  const errors = await start(page, { settings: JSON.stringify(settings) });
  await page.getByLabel("Color mode", { exact: true }).selectOption("light");
  expect((await snapshotFS(page)).writes).toEqual([]);
  await folders(page, false, true);
  await expect(
    page.getByRole("radio", { name: "Reference 5", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Color mode", { exact: true })).toHaveValue(
    "light",
  );
  await expect(page.getByLabel("Effects", { exact: true })).toHaveValue(
    "reduced",
  );
  await expect
    .poll(async () => JSON.parse((await snapshotFS(page)).settings!))
    .toEqual({
      ...settings,
      appearance: { ...settings.appearance, mode: "light" },
    });
  expect(errors).toEqual([]);
});

test("failed settings writes keep the last valid values and show unsaved state", async ({
  page,
}) => {
  const errors = await start(page, {
    settings: JSON.stringify(settingsFixture()),
  });
  await folders(page, false, true);
  await expect(
    page.getByText("Appearance saved in your settings folder.", {
      exact: true,
    }),
  ).toBeVisible();
  const previous = (await snapshotFS(page)).settings;
  await page.evaluate(() => window.fixtureFS.failSettingsWrite(true));
  await page.getByLabel("Color mode", { exact: true }).selectOption("light");
  await expect(
    page.getByText(
      "Appearance is not saved. Retry settings access. The last valid file is unchanged.",
      { exact: true },
    ),
  ).toBeVisible();
  expect((await snapshotFS(page)).settings).toBe(previous);
  await expect(page.getByLabel("Color mode", { exact: true })).toHaveValue(
    "light",
  );
  expect(errors).toEqual([]);
});

test("corrupt settings remain unchanged while appearance controls stay usable", async ({
  page,
}) => {
  const original = "{broken settings";
  const errors = await start(page, { settings: original });
  await folders(page, false, true);
  await expect(page.getByText(/Saved settings are invalid/)).toBeVisible();
  await page.getByRole("radio", { name: "Reference 4", exact: true }).click();
  await expect(page.locator(".material-root")).toHaveAttribute(
    "data-skin",
    "reference-4",
  );
  const after = await snapshotFS(page);
  expect(after.settings).toBe(original);
  expect(
    after.writes.some((item) => item.path.endsWith("ravefold-settings.json")),
  ).toBe(false);
  expect(errors).toEqual([]);
});

test("empty, corrupt and MP3-only selections never satisfy sample validity", async ({
  page,
}) => {
  const errors = await start(page);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await folders(page, false, true);
  await page
    .getByRole("button", { name: "Folder settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  for (const kind of ["empty", "corrupt", "mp3"] as const) {
    await page.evaluate((value) => window.fixtureFS.queueSample(value), kind);
    await dialog
      .getByRole("button", { name: "Select sample folder", exact: true })
      .click();
    await expect(
      dialog.getByText(
        {
          empty: "Empty samples",
          corrupt: "Corrupt samples",
          mp3: "MP3 samples",
        }[kind],
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText("No supported WAV files were found.", { exact: true }),
    ).toBeVisible();
  }
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Enter tracker", exact: true }),
  ).toBeDisabled();
  expect((await snapshotFS(page)).entries).toEqual([]);
  expect(errors).toEqual([]);
});

test("cancelled picker keeps the previous valid selection", async ({
  page,
}) => {
  const errors = await start(page);
  await folders(page);
  await page
    .getByRole("button", { name: "Folder settings", exact: true })
    .click();
  await page.evaluate(() => window.fixtureFS.cancelPicker("samples"));
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Select sample folder", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("Folder selection cancelled.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText("Sample library", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Enter tracker", exact: true }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});

test("results from an older scan cannot validate a new empty selection", async ({
  page,
}) => {
  const errors = await start(page);
  await folders(page, false, true);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page
    .getByRole("button", { name: "Folder settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await page.evaluate(() => window.fixtureFS.queueSample("slow"));
  await dialog
    .getByRole("button", { name: "Select sample folder", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Stop check", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.fixtureFS.queueSample("empty"));
  await dialog
    .getByRole("button", { name: "Select sample folder", exact: true })
    .click();
  await expect(
    dialog.getByText("No supported WAV files were found.", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.fixtureFS.releaseSlow());
  await expect(
    dialog.getByText("Empty samples", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Enter tracker", exact: true }),
  ).toBeDisabled();
  expect((await snapshotFS(page)).entries).toEqual([]);
  expect(errors).toEqual([]);
});

test("stopping discovery before the first valid file leaves entry disabled", async ({
  page,
}) => {
  const errors = await start(page);
  await folders(page, false, true);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page
    .getByRole("button", { name: "Folder settings", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await page.evaluate(() => window.fixtureFS.queueSample("slow"));
  await dialog
    .getByRole("button", { name: "Select sample folder", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Stop check", exact: true }).click();
  await page.evaluate(() => window.fixtureFS.releaseSlow());
  await expect(
    dialog.getByText("Folder check stopped. Retry to complete the check.", {
      exact: true,
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Enter tracker", exact: true }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});
