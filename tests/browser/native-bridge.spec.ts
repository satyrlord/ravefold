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
    await page.getByRole("radio", { name: "Reference 5", exact: true }).click();
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
