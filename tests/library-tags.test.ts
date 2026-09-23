import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  emptyTagManifest,
  MAX_TAGS_BYTES,
  normalizeTags,
  readTags,
  saveSampleTags,
  TAGS_FILENAME,
  validateTagManifest,
} from "../src/library/tags.ts";
import { LibraryDirectory } from "./library-fixtures.ts";

test("tag schema rejects unsafe paths, extra fields and unrecognized versions", () => {
  for (const path of [
    "../kick.wav",
    "/kick.wav",
    "Drums\\kick.wav",
    "kick.mp3",
    "folder./kick.wav",
  ]) {
    assert.throws(() =>
      validateTagManifest({
        ...emptyTagManifest(),
        samples: { [path]: { tags: [] } },
      }),
    );
  }
  for (const invalid of [
    { ...emptyTagManifest(), schemaVersion: 2 },
    { ...emptyTagManifest(), audio: [1, 2, 3] },
    { ...emptyTagManifest(), revision: -1 },
    {
      ...emptyTagManifest(),
      samples: { "kick.wav": { tags: [], ready: true } },
    },
    {
      ...emptyTagManifest(),
      samples: { "kick.wav": { tags: ["heavy", "HEAVY"] } },
    },
  ])
    assert.throws(() => validateTagManifest(invalid));
  assert.deepEqual(normalizeTags([" heavy ", "Heavy", "One shot"]), [
    "heavy",
    "One shot",
  ]);
  for (const tags of [
    [""],
    ["x".repeat(41)],
    ["two,tags"],
    ["bad\nvalue"],
    Array(33).fill("x"),
  ])
    assert.throws(() => normalizeTags(tags));
});

test("tags reload by relative path while duplicate names and audio hashes stay unchanged", async () => {
  const root = new LibraryDirectory();
  const first = root.folder("Drums").file("hit.wav", "first source");
  const second = root.folder("Effects").file("hit.wav", "second source");
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const before = [hash(first.contents), hash(second.contents)];
  assert.equal((await readTags(root)).status, "missing");
  await saveSampleTags(root, "Drums/hit.wav", ["Heavy"]);
  const reloaded = await readTags(root);
  assert.equal(reloaded.status, "valid");
  if (reloaded.status !== "valid") throw new Error("Expected saved manifest.");
  assert.deepEqual(reloaded.value.samples["Drums/hit.wav"]?.tags, ["Heavy"]);
  assert.equal(reloaded.value.samples["Effects/hit.wav"], undefined);
  assert.deepEqual([hash(first.contents), hash(second.contents)], before);
  assert.equal(first.writes + second.writes, 0);
  assert.deepEqual(
    [...root.children.keys()].sort(),
    ["Drums", "Effects", TAGS_FILENAME].sort(),
  );
});

test("concurrent saves merge different records and reject a stale edit to the same record", async () => {
  const root = new LibraryDirectory();
  await Promise.all([
    saveSampleTags(root, "Drums/hit.wav", ["Drum"]),
    saveSampleTags(root, "Effects/hit.wav", ["Effect"]),
  ]);
  const attempts = await Promise.allSettled([
    saveSampleTags(root, "Drums/hit.wav", ["First"], {
      expectedTags: ["Drum"],
    }),
    saveSampleTags(root, "Drums/hit.wav", ["Second"], {
      expectedTags: ["Drum"],
    }),
  ]);
  assert.deepEqual(
    attempts.map((item) => item.status),
    ["fulfilled", "rejected"],
  );
  const read = await readTags(root);
  assert.equal(read.status, "valid");
  if (read.status !== "valid") throw new Error("Expected saved manifest.");
  assert.equal(read.value.revision, 3);
  assert.deepEqual(read.value.samples, {
    "Drums/hit.wav": { tags: ["First"] },
    "Effects/hit.wav": { tags: ["Effect"] },
  });
});

test("denied or interrupted tag commits retain the previous valid manifest", async () => {
  for (const failure of ["denied", "close", "cancel"] as const) {
    const root = new LibraryDirectory();
    await saveSampleTags(root, "hit.wav", ["Saved"]);
    const handle = await root.getFileHandle(TAGS_FILENAME);
    const previous = handle.contents;
    const controller = new AbortController();
    if (failure === "denied")
      handle.onWrite = () => {
        root.state = "denied";
      };
    if (failure === "close") handle.failClose = true;
    if (failure === "cancel") handle.onWrite = () => controller.abort();
    await assert.rejects(
      saveSampleTags(root, "hit.wav", ["Unsaved"], {
        expectedTags: ["Saved"],
        signal: controller.signal,
      }),
    );
    assert.equal(handle.contents, previous, failure);
    assert.equal(handle.aborts, 1);
    assert.equal(handle.active, 0);
  }
});

test("a failed first tag commit removes only its own empty manifest", async () => {
  const root = new LibraryDirectory();
  root.file("source.wav");
  root.onCreate = (handle) => {
    if (handle.name === TAGS_FILENAME) handle.failClose = true;
  };
  await assert.rejects(saveSampleTags(root, "source.wav", ["Unsaved"]));
  assert.ok(root.removals.includes(TAGS_FILENAME));
  assert.ok(
    root.removals.every(
      (name) => name === TAGS_FILENAME || /^\.ravefold-tags-lock-/u.test(name),
    ),
  );
  assert.deepEqual([...root.children.keys()], ["source.wav"]);
});

test("external manifest changes before commit are preserved", async () => {
  const root = new LibraryDirectory();
  await saveSampleTags(root, "hit.wav", ["Saved"]);
  const handle = await root.getFileHandle(TAGS_FILENAME);
  const external = JSON.stringify({
    schemaVersion: 1,
    revision: 2,
    samples: { "hit.wav": { tags: ["External"] } },
  });
  handle.onWrite = () => {
    handle.contents = external;
  };
  await assert.rejects(
    saveSampleTags(root, "hit.wav", ["Unsaved"], { expectedTags: ["Saved"] }),
    /another session/u,
  );
  assert.equal(handle.contents, external);
  assert.equal(handle.active, 0);
});

test("shared reservations protect writes without Web Locks or exclusive file support", async () => {
  const root = new LibraryDirectory();
  root.onCreate = (file) => {
    file.exclusive = false;
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });
  try {
    await saveSampleTags(root, "hit.wav", ["Saved"]);
    assert.equal((await readTags(root)).status, "valid");
    assert.deepEqual([...root.children.keys()], [TAGS_FILENAME]);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("tag writes take an exclusive Web Lock when it is available", async () => {
  const root = new LibraryDirectory();
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const requests: unknown[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async (
          name: string,
          options: unknown,
          run: () => Promise<unknown>,
        ) => {
          requests.push({ name, options });
          return run();
        },
      },
    },
  });
  try {
    await saveSampleTags(root, "hit.wav", ["Saved"]);
    assert.deepEqual(requests, [
      { name: "ravefold-sample-tags-v1", options: { mode: "exclusive" } },
    ]);
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("invalid, disguised audio and oversized manifests cannot be replaced", async () => {
  for (const contents of [
    "not JSON",
    "RIFF----WAVEsource",
    "x".repeat(MAX_TAGS_BYTES + 1),
    JSON.stringify({ ...emptyTagManifest(), schemaVersion: 2 }),
  ]) {
    const root = new LibraryDirectory();
    const file = root.file(TAGS_FILENAME, contents);
    assert.equal((await readTags(root)).status, "invalid");
    await assert.rejects(saveSampleTags(root, "hit.wav", ["Unsaved"]));
    assert.equal(file.contents, contents);
    assert.equal(file.writes, 0);
  }
  const root = new LibraryDirectory();
  root.file(TAGS_FILENAME, JSON.stringify(emptyTagManifest())).failRead = true;
  assert.equal((await readTags(root)).status, "unavailable");
});
