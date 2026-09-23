import { expect, test, type Page } from "@playwright/test";
import { installFixtureFS, snapshotFS } from "./fixture-fs.ts";

function samplePxd(): Buffer {
  const metadata = Buffer.from("Sample\0", "ascii");
  const header = Buffer.alloc(5 + metadata.length + 7);
  header.write("tPxD", 0, "ascii");
  header[4] = metadata.length;
  metadata.copy(header, 5);
  const end = 5 + metadata.length;
  header[end] = 0x54;
  header.writeUInt32LE(4, end + 1);
  return Buffer.concat([header, Buffer.from([0x81, 0x80, 0x81, 0x80])]);
}

async function mockArchive(page: Page, pxd: Buffer) {
  const path = "RAVE/AA/TEST.PXD";
  const member =
    "https://archive.org/download/raveejay_202005/raveejay.iso/RAVE%2FAA%2FTEST.PXD";
  await page.route(
    "https://archive.org/download/raveejay_202005/raveejay.iso/",
    (route) =>
      route.fulfill({
        contentType: "text/html",
        headers: { "access-control-allow-origin": "*" },
        body: `<html><table><tr><td><a href="${member}">${path}</a></td><td></td><td id="size">${pxd.length}</td></tr></table></html>`,
      }),
  );
  await page.route(member, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({
      contentType: "application/octet-stream",
      headers: { "access-control-allow-origin": "*" },
      body: pxd,
    });
  });
}

test("an empty folder becomes valid and archive retry protects existing audio", async ({
  page,
}) => {
  await mockArchive(page, samplePxd());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installFixtureFS(page);
  await page.goto("/");
  const button = page.getByRole("button", {
    name: "Import Rave eJay ISO",
    exact: true,
  });
  await expect(button).toBeEnabled();
  await page.evaluate(() => window.fixtureFS.queueSample("empty"));
  await button.click();
  await expect(
    page.getByRole("progressbar", { name: "Archive import progress" }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "1 WAV sample is ready" }),
  ).toBeVisible();
  await expect(
    page.getByText("Sample folder is ready.", { exact: true }),
  ).toBeVisible();
  const first = await snapshotFS(page);
  expect(first.selectedAudio.map((file) => file.path)).toContain(
    "Empty samples/Rave eJay ISO/RAVE/AA/TEST.wav",
  );
  await expect(button).toBeEnabled();
  await button.click();
  await expect(
    page.getByRole("status").filter({ hasText: "1 WAV sample is ready" }),
  ).toBeVisible();
  expect((await snapshotFS(page)).selectedAudio).toEqual(first.selectedAudio);
  await page.evaluate(() =>
    window.fixtureFS.changeSelectedAudio("Rave eJay ISO/RAVE/AA/TEST.wav"),
  );
  const changed = (await snapshotFS(page)).selectedAudio;
  expect(changed).not.toEqual(first.selectedAudio);
  await button.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "already exists with different audio" }),
  ).toBeVisible();
  expect((await snapshotFS(page)).selectedAudio).toEqual(changed);
  await expect(button).toBeEnabled();
});

test("stopping a browser write keeps the empty file and retry uses a new name", async ({
  page,
}) => {
  await mockArchive(page, samplePxd());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installFixtureFS(page);
  await page.goto("/");
  await page.evaluate(() => {
    window.fixtureFS.queueSample("empty");
    window.fixtureFS.blockAudioWrite();
  });
  const button = page.getByRole("button", {
    name: "Import Rave eJay ISO",
    exact: true,
  });
  await button.click();
  await expect
    .poll(() => page.evaluate(() => window.fixtureFS.audioWriteStarted()))
    .toBe(true);
  await page.getByRole("button", { name: "Stop import" }).click();
  await page.evaluate(() => window.fixtureFS.releaseAudioWrite());
  await expect(
    page.getByRole("status").filter({ hasText: "Import stopped" }),
  ).toBeVisible();
  const partial = (await snapshotFS(page)).selectedAudio;
  expect(partial.map((file) => file.path)).toContain(
    "Empty samples/Rave eJay ISO/RAVE/AA/TEST.wav",
  );
  await expect(button).toBeEnabled();
  await button.click();
  await expect(
    page.getByRole("status").filter({ hasText: "1 WAV sample is ready" }),
  ).toBeVisible();
  const finished = (await snapshotFS(page)).selectedAudio;
  expect(finished).toContainEqual(partial[0]!);
  expect(finished.map((file) => file.path)).toContain(
    "Empty samples/Rave eJay ISO/RAVE/AA/TEST (2).wav",
  );
});
