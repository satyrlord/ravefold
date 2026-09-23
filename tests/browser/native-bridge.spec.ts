import { test, expect } from "@playwright/test";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, dirname, basename } from "node:path";
import { extensionHarness } from "../extension-harness.ts";
import { projectFixture } from "../fixtures.ts";
import type { EntryResult } from "../../src/domain/entry.ts";

test("the built native view imports the ISO members into an empty Samples folder", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const parent = resolve("tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "native-archive-"));
  const samples = join(root, "samples");
  await mkdir(samples);
  const pxd = Buffer.alloc(5 + 7 + 7 + 2);
  pxd.write("tPxD", 0, "ascii");
  pxd[4] = 7;
  pxd.write("Sample\0", 5, "ascii");
  pxd[12] = 0x54;
  pxd.writeUInt32LE(2, 13);
  pxd[19] = 0x81;
  pxd[20] = 0x80;
  const member =
    "https://archive.org/download/raveejay_202005/raveejay.iso/RAVE%2FAA%2FTEST.PXD";
  const host = await extensionHarness({ built: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await host.command("ravefold.open");
    expect(host.html()).toContain("https://*.archive.org");
    await page.route("http://127.0.0.1:4173/", (route) =>
      route.fulfill({ contentType: "text/html", body: host.html() }),
    );
    await page.route(
      "https://archive.org/download/raveejay_202005/raveejay.iso/",
      (route) =>
        route.fulfill({
          contentType: "text/html",
          headers: { "access-control-allow-origin": "*" },
          body: `<html><table><tr><td><a href="${member}">RAVE/AA/TEST.PXD</a></td><td></td><td id="size">${pxd.length}</td></tr></table></html>`,
        }),
    );
    await page.route(member, (route) =>
      route.fulfill({
        contentType: "application/octet-stream",
        headers: { "access-control-allow-origin": "*" },
        body: pxd,
      }),
    );
    await page.exposeBinding(
      "nativeFixtureRequest",
      async (_source, message: unknown) => host.send(message),
    );
    await page.addInitScript(() => {
      const scope = window as unknown as {
        acquireVsCodeApi: () => unknown;
        nativeFixtureRequest: (message: unknown) => Promise<unknown>;
      };
      scope.acquireVsCodeApi = () => ({
        postMessage: (message: unknown) => {
          void scope
            .nativeFixtureRequest(message)
            .then((reply) =>
              window.dispatchEvent(
                new MessageEvent("message", { data: reply }),
              ),
            );
        },
      });
    });
    host.pickerPaths.push(samples);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.getByRole("button", { name: "Import Rave eJay ISO" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "1 WAV sample is ready" }),
    ).toBeVisible();
    const wav = await readFile(
      join(samples, "Rave eJay ISO", "RAVE", "AA", "TEST.wav"),
    );
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(await readdir(samples)).toEqual(["Rave eJay ISO"]);
    expect(errors).toEqual([]);
  } finally {
    host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("the built native extension supports folder setup, reload, entry and revocation without audio changes", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const parent = resolve("tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "native-browser-"));
  const samples = join(root, "samples"),
    settings = join(root, "settings");
  await mkdir(join(samples, "drums"), { recursive: true });
  await mkdir(settings);
  const wav = Buffer.alloc(52);
  wav.write("RIFF");
  wav.writeUInt32LE(44, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(44100, 24);
  wav.writeUInt32LE(88200, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(8, 40);
  await writeFile(join(samples, "drums", "kick.wav"), wav);
  const hash = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  const initialHash = hash(wav);
  const host = await extensionHarness({ built: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await host.command("ravefold.open");
    expect(host.html()).toContain('data-ravefold-native="1"');
    expect(host.notices).toEqual([]);
    await page.route("http://127.0.0.1:4173/", (route) =>
      route.fulfill({ contentType: "text/html", body: host.html() }),
    );
    await page.exposeBinding(
      "nativeFixtureRequest",
      async (_source, message: unknown) => host.send(message),
    );
    await page.addInitScript(() => {
      const scope = window as unknown as {
        acquireVsCodeApi: () => unknown;
        nativeFixtureRequest: (message: unknown) => Promise<unknown>;
        nativeEntries: unknown[];
      };
      scope.nativeEntries = [];
      window.addEventListener("ravefold:entry", (event) => {
        const value = (event as CustomEvent).detail as EntryResult;
        scope.nativeEntries.push({
          mode: value.mode,
          project: value.project,
          missingSamples: value.missingSamples,
        });
      });
      scope.acquireVsCodeApi = () => ({
        postMessage: (message: unknown) => {
          void scope
            .nativeFixtureRequest(message)
            .then((reply) =>
              window.dispatchEvent(
                new MessageEvent("message", { data: reply }),
              ),
            );
        },
      });
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.addStyleTag({
      content:
        "@layer vscode-default { body { font-family: Arial, sans-serif; font-size: 13px; padding: 0 20px; } }",
    });
    const fontState = await page.evaluate(async () => {
      await document.fonts.ready;
      return {
        family: getComputedStyle(document.body).fontFamily,
        size: getComputedStyle(document.body).fontSize,
        padding: getComputedStyle(document.body).paddingLeft,
        loaded: [...document.fonts].filter(
          (font) =>
            font.family === "Space Grotesk Variable" &&
            font.status === "loaded",
        ).length,
      };
    });
    expect(fontState.family).toMatch(/^"?Space Grotesk Variable/);
    expect(fontState.size).toBe("16px");
    expect(fontState.padding).toBe("0px");
    expect(fontState.loaded).toBeGreaterThan(0);
    host.pickerPaths.push(samples, settings);
    await page
      .getByRole("button", { name: "Folder settings", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
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
    await page.getByRole("radio", { name: "Neon", exact: true }).click();
    await expect(page.locator(".appearance-status")).toHaveText(
      "Appearance saved in your settings folder.",
    );
    expect(
      JSON.parse(
        await readFile(join(settings, "ravefold-settings.json"), "utf8"),
      ).appearance.skin,
    ).toBe("reference-5");
    await page.reload();
    await expect(page.locator(".material-root")).toHaveAttribute(
      "data-skin",
      "reference-5",
    );
    await expect(
      page.getByText("Sample folder is ready.", { exact: true }),
    ).toBeVisible();
    const project = projectFixture();
    await page.getByLabel("Project file", { exact: true }).setInputFiles({
      name: "native.ravefold.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(project)),
    });
    await page
      .getByRole("button", { name: "Enter tracker", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Project ready", exact: true }),
    ).toBeVisible();
    const entries = await page.evaluate(
      () =>
        (
          window as unknown as {
            nativeEntries: Array<{
              project: unknown;
              missingSamples: unknown[];
            }>;
          }
        ).nativeEntries,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.project).toEqual(project);
    expect(entries[0]?.missingSamples.length).toBeGreaterThan(0);
    expect(hash(await readFile(join(samples, "drums", "kick.wav")))).toBe(
      initialHash,
    );
    expect(await readdir(samples)).toEqual(["drums"]);
    expect(await readdir(settings)).toEqual(["ravefold-settings.json"]);
    expect([...host.saved.keys()]).toEqual(["ravefold.folderReferences.v1"]);
    expect(
      await page.evaluate(async () => ({
        local: localStorage.length,
        session: sessionStorage.length,
        databases: (await indexedDB.databases()).length,
      })),
    ).toEqual({ local: 0, session: 0, databases: 0 });
    host.messages((message) => {
      void page.evaluate(
        (data) => window.dispatchEvent(new MessageEvent("message", { data })),
        message,
      );
    });
    await host.command("ravefold.forgetFolders");
    await expect(
      page.getByRole("button", { name: "Enter tracker", exact: true }),
    ).toBeDisabled();
    expect(host.saved.size).toBe(0);
    expect(hash(await readFile(join(samples, "drums", "kick.wav")))).toBe(
      initialHash,
    );
    expect(errors).toEqual([]);
  } finally {
    host.dispose();
    const target = resolve(root);
    expect(dirname(target)).toBe(parent);
    expect(basename(target)).toMatch(/^native-browser-/);
    await rm(target, { recursive: true, force: true });
  }
});
