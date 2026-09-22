import { expect, test, type Page } from "@playwright/test";

test.use({ contextOptions: { reducedMotion: "reduce" } });

function generatedWav(): number[] {
  const bytes = new Uint8Array(52);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    [...value].forEach((character, index) => {
      bytes[offset + index] = character.charCodeAt(0);
    });
  };
  text(0, "RIFF");
  view.setUint32(4, 44, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 88200, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 8, true);
  view.setInt16(44, 800, true);
  view.setInt16(46, -800, true);
  view.setInt16(48, 400, true);
  view.setInt16(50, -400, true);
  return Array.from(bytes);
}

async function storedReferences(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ravefold-folder-references", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const stores = Array.from(database.objectStoreNames);
      const result = await new Promise<{
        keys: string[];
        names: string[];
        nativeHandlesOnly: boolean;
      }>((resolve, reject) => {
        const transaction = database.transaction("references", "readonly");
        const store = transaction.objectStore("references");
        const keys = store.getAllKeys();
        const values = store.getAll();
        transaction.oncomplete = () =>
          resolve({
            keys: keys.result.map(String).sort(),
            names: (values.result as FileSystemDirectoryHandle[])
              .map((handle) => handle.name)
              .sort(),
            nativeHandlesOnly: values.result.every(
              (value: unknown) => value instanceof FileSystemDirectoryHandle,
            ),
          });
        transaction.onerror = transaction.onabort = () =>
          reject(transaction.error);
      });
      return { stores, ...result };
    } finally {
      database.close();
    }
  });
}

async function fixtureHashes(page: Page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const samples = await root.getDirectoryHandle("samples");
    const nested = await samples.getDirectoryHandle("generated");
    const settings = await root.getDirectoryHandle("settings");
    const hash = async (handle: FileSystemFileHandle) => {
      const bytes = await (await handle.getFile()).arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    };
    return {
      audio: await hash(await nested.getFileHandle("pulse.wav")),
      settings: await hash(
        await settings.getFileHandle("ravefold-settings.json"),
      ),
    };
  });
}

async function selectFolders(page: Page) {
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
}

test("native folder handles survive reload and database removal leaves fixture files intact", async ({
  page,
}, testInfo) => {
  testInfo.annotations.push({
    type: "evidence-limit",
    description:
      "The harness uses origin-private file system directories for native handle cloning. It does not prove native picker success or disk grants.",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const scope = window as unknown as Window & {
      fixturePermissionQueries: string[];
      showDirectoryPicker: (options: {
        id: string;
      }) => Promise<FileSystemDirectoryHandle>;
    };
    scope.fixturePermissionQueries = [];
    const descriptor = Object.getOwnPropertyDescriptor(
      FileSystemHandle.prototype,
      "queryPermission",
    );
    const query = descriptor?.value as
      | ((
          this: FileSystemHandle,
          options: { mode: string },
        ) => Promise<PermissionState>)
      | undefined;
    if (!descriptor || !query)
      throw new Error("Native handle permission queries are unavailable.");
    Object.defineProperty(FileSystemHandle.prototype, "queryPermission", {
      ...descriptor,
      value: function (this: FileSystemHandle, options: { mode: string }) {
        scope.fixturePermissionQueries.push(this.name);
        return query.call(this, options);
      },
    });
    scope.showDirectoryPicker = async (options) => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle(
        options.id === "ravefold-samples" ? "samples" : "settings",
      );
    };
  });
  await page.goto("/");
  await page.evaluate(async (data) => {
    const root = await navigator.storage.getDirectory();
    const samples = await root.getDirectoryHandle("samples", { create: true });
    const nested = await samples.getDirectoryHandle("generated", {
      create: true,
    });
    await root.getDirectoryHandle("settings", { create: true });
    const file = await nested.getFileHandle("pulse.wav", { create: true });
    const writer = await file.createWritable();
    await writer.write(new Uint8Array(data));
    await writer.close();
  }, generatedWav());

  await selectFolders(page);
  await page.getByRole("radio", { name: "Reference 4", exact: true }).click();
  await page.getByLabel("Color mode", { exact: true }).selectOption("light");
  await page.getByLabel("Effects", { exact: true }).selectOption("static");
  await expect(page.locator(".appearance-status")).toHaveText(
    "Appearance saved in your settings folder.",
  );
  await expect
    .poll(() => storedReferences(page))
    .toEqual({
      stores: ["references"],
      keys: ["samples", "settings"],
      names: ["samples", "settings"],
      nativeHandlesOnly: true,
    });
  const before = await fixtureHashes(page);

  await page.reload();
  await expect(page.locator(".material-root")).toHaveAttribute(
    "data-skin",
    "reference-4",
  );
  await expect(page.getByLabel("Color mode", { exact: true })).toHaveValue(
    "light",
  );
  await expect(page.getByLabel("Effects", { exact: true })).toHaveValue(
    "static",
  );
  await expect(page.locator(".appearance-status")).toHaveText(
    "Appearance saved in your settings folder.",
  );
  const queries = await page.evaluate(
    () =>
      (window as unknown as Window & { fixturePermissionQueries: string[] })
        .fixturePermissionQueries,
  );
  expect(queries).toEqual(expect.arrayContaining(["samples", "settings"]));
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Enter tracker", exact: true }),
  ).toBeEnabled();
  expect(await fixtureHashes(page)).toEqual(before);
  expect(await storedReferences(page)).toEqual({
    stores: ["references"],
    keys: ["samples", "settings"],
    names: ["samples", "settings"],
    nativeHandlesOnly: true,
  });

  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase("ravefold-folder-references");
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () =>
          reject(new Error("The folder reference database is still open."));
      }),
  );
  expect(await fixtureHashes(page)).toEqual(before);
  await page.reload();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Enter tracker", exact: true }),
  ).toBeDisabled();
  expect(await storedReferences(page)).toEqual({
    stores: ["references"],
    keys: [],
    names: [],
    nativeHandlesOnly: true,
  });
  expect(await fixtureHashes(page)).toEqual(before);
  await selectFolders(page);
  await expect(
    page.getByRole("button", { name: "Enter tracker", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".appearance-status")).toHaveText(
    "Appearance saved in your settings folder.",
  );
  expect(await fixtureHashes(page)).toEqual(before);
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });
  expect(errors).toEqual([]);
});
