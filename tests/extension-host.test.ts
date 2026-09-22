import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { NATIVE_CHANNEL, NATIVE_VERSION } from "../shared/native-protocol.ts";
import { extensionHarness } from "./extension-harness.ts";

test("the native extension requires workspace trust before it opens a view", async () => {
  const host = await extensionHarness({ trusted: false });
  try {
    assert.deepEqual([...host.commands.keys()].sort(), [
      "ravefold.forgetFolders",
      "ravefold.open",
    ]);
    await host.command("ravefold.open");
    assert.equal(host.html(), "");
    assert.equal(
      host.notices[0],
      "RaveFold needs a trusted window for folder access.",
    );
  } finally {
    host.dispose();
  }
});

test("forget folders removes only the saved access references", async () => {
  const saved = new Map<string, unknown>([
    ["ravefold.folderReferences.v1", { samples: "opaque test reference" }],
    ["unrelated", "keep"],
  ]);
  const host = await extensionHarness({ saved });
  try {
    await host.command("ravefold.forgetFolders");
    assert.equal(saved.has("ravefold.folderReferences.v1"), false);
    assert.equal(saved.get("unrelated"), "keep");
  } finally {
    host.dispose();
  }
});

test("a closed view cannot restore grants into the next view", async () => {
  const root = await mkdtemp(join(tmpdir(), "ravefold-host-test-"));
  const samples = join(root, "samples");
  const nested = join(samples, "nested");
  await mkdir(nested, { recursive: true });
  const info = await stat(samples);
  const saved = new Map<string, unknown>([
    [
      "ravefold.folderReferences.v1",
      {
        samples: {
          path: await realpath(samples),
          identity: `${info.dev}:${info.ino}`,
        },
      },
    ],
  ]);
  const host = await extensionHarness({ saved });
  try {
    await host.command("ravefold.open");
    let reopened: Promise<unknown> | undefined;
    const get = saved.get.bind(saved);
    saved.get = (key) => {
      const value = get(key);
      if (!reopened) {
        host.close();
        reopened = Promise.resolve(host.command("ravefold.open"));
      }
      return value;
    };
    host.post({
      channel: NATIVE_CHANNEL,
      version: NATIVE_VERSION,
      id: "old-load",
      request: { op: "loadReferences" },
    });
    await new Promise<void>((done) => setImmediate(done));
    assert.ok(reopened);
    await reopened;
    host.pickerPaths.push(nested);
    const reply = await host.send({
      channel: NATIVE_CHANNEL,
      version: NATIVE_VERSION,
      id: "new-pick",
      request: { op: "pickFolder", kind: "settings" },
    });
    assert.equal(reply.ok, true);
  } finally {
    host.dispose();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
