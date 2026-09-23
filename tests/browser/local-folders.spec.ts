import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { localFolderPlugin } from "../../scripts/local-folder-plugin.ts";
import { localFolderFixture } from "../local-folder-fixture.ts";

let server: ViteDevServer;
let fixture: Awaited<ReturnType<typeof localFolderFixture>>;
let origin: string;

test.beforeAll(async () => {
  fixture = await localFolderFixture();
  server = await createServer({
    configFile: false,
    mode: "local-folders",
    plugins: [localFolderPlugin(fixture)],
    server: { port: 0 },
    logLevel: "silent",
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string")
    throw new Error("The local test server did not start.");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
  await fixture?.dispose();
});

test("local folders support tracker entry, audio and saved tags when browser folder access is denied", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: () =>
        Promise.reject(
          new DOMException("Host denied access.", "NotAllowedError"),
        ),
    });
    Object.defineProperty(FileSystemHandle.prototype, "queryPermission", {
      configurable: true,
      value: async () => "denied",
    });
    Object.defineProperty(FileSystemHandle.prototype, "requestPermission", {
      configurable: true,
      value: async () => "denied",
    });
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page
    .getByRole("button", { name: "Enter tracker", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Drums/kick.wav", exact: true })
    .click();
  await page.getByRole("button", { name: "Play source", exact: true }).click();
  await expect(
    page.getByText("Source preview is playing.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  await page
    .getByRole("button", { name: "Show waveform", exact: true })
    .click();
  await expect(
    page.getByRole("img", {
      name: "Source waveform: Drums/kick.wav",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "New tag", exact: true })
    .fill("local-proof");
  await page.getByRole("button", { name: "Add tag", exact: true }).click();
  await page.getByRole("button", { name: "Save tags", exact: true }).click();
  await expect(page.getByText("Tags saved.", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  const manifest = JSON.parse(
    await readFile(
      join(fixture.samples, "ravefold-tags.manifest.json"),
      "utf8",
    ),
  );
  expect(manifest.samples["Drums/kick.wav"].tags).toEqual(["local-proof"]);
  await page.reload();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page
    .getByRole("button", { name: "Enter tracker", exact: true })
    .click();
  await page
    .getByRole("searchbox", { name: "Search files or tags", exact: true })
    .fill("local-proof");
  await expect(
    page.getByRole("button", { name: "Drums/kick.wav", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      databases: (await indexedDB.databases()).length,
    })),
  ).toEqual({ local: 0, session: 0, databases: 0 });
  const hash = (value: Buffer) =>
    createHash("sha256").update(value).digest("hex");
  expect(hash(await readFile(join(fixture.samples, "Drums", "kick.wav")))).toBe(
    hash(fixture.audio),
  );
  expect(errors).toEqual([]);
});

test("production preview does not expose local folder mode", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator('meta[name="ravefold-local-token"]')).toHaveCount(
    0,
  );
  const response = await request.post("/__ravefold_local/files", {
    data: { op: "roots" },
  });
  expect(response.headers()["content-type"] ?? "").not.toContain(
    "application/json",
  );
});
