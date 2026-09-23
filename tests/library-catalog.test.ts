import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverCatalog, filterCatalog } from "../src/library/catalog.ts";
import { emptyTagManifest } from "../src/library/tags.ts";
import { LibraryDirectory } from "./library-fixtures.ts";

test("catalog keeps duplicate names at distinct relative paths without reading audio", async () => {
  const root = new LibraryDirectory();
  const first = root.folder("Drums").file("hit.wav");
  const second = root.folder("Effects").file("hit.wav");
  root.folder("Empty");
  root.file("unsupported.mp3");
  root.file("metadata.json");
  const result = await discoverCatalog(root);
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.rows.map((row) => row.id),
    ["Drums/hit.wav", "Effects/hit.wav"],
  );
  assert.deepEqual(
    result.folders,
    ["", "Drums", "Effects", "Empty"].sort((a, b) => a.localeCompare(b)),
  );
  assert.equal(result.rows[0]?.handle, first);
  assert.equal(result.rows[1]?.handle, second);
  assert.equal(first.reads + second.reads, 0);
  assert.ok(
    result.rows.every(
      (row) => row.format === "WAV" && row.preparation === "not-prepared",
    ),
  );
});

test("filters match names or saved tags across folders without changing the catalog", async () => {
  const root = new LibraryDirectory();
  root.folder("Drums").folder("Hits").file("KICK.wav");
  root.folder("Effects").file("impact.wav");
  root.folder("Drums 2").file("kick.wav");
  const { rows } = await discoverCatalog(root);
  const manifest = emptyTagManifest();
  manifest.samples["Drums/Hits/KICK.wav"] = { tags: ["Heavy", "One shot"] };
  manifest.samples["Effects/impact.wav"] = { tags: ["Heavy"] };
  assert.deepEqual(
    filterCatalog(rows, { query: "kick" }, manifest)
      .map((row) => row.path)
      .sort(),
    ["Drums 2/kick.wav", "Drums/Hits/KICK.wav"],
  );
  assert.equal(filterCatalog(rows, { query: "HEAVY" }, manifest).length, 2);
  assert.equal(
    filterCatalog(rows, { tag: "heavy", folder: "Drums" }, manifest)[0]?.path,
    "Drums/Hits/KICK.wav",
  );
  assert.equal(filterCatalog(rows, { tag: "Heav" }, manifest).length, 0);
  assert.equal(filterCatalog(rows, { folder: "Drums" }, manifest).length, 1);
  assert.equal(rows.length, 3);
  assert.deepEqual(manifest.samples["Effects/impact.wav"]?.tags, ["Heavy"]);
});

test("catalog reports denied child folders and rejects a denied root", async () => {
  const root = new LibraryDirectory();
  root.file("available.wav");
  root.folder("Locked").state = "denied";
  root.folder("../outside").file("invalid.wav");
  const result = await discoverCatalog(root);
  assert.equal(result.complete, false);
  assert.deepEqual(result.inaccessible.sort(), ["../outside", "Locked"]);
  assert.equal(result.rows.length, 1);
  root.state = "denied";
  await assert.rejects(discoverCatalog(root), { name: "NotAllowedError" });
});

test("large catalog publishes rows and yields without audio reads or decoding", async () => {
  const root = new LibraryDirectory();
  for (let index = 0; index < 10_000; index++) root.file(`sample-${index}.wav`);
  let firstProgress = 0;
  let yielded = false;
  const timer = setTimeout(() => {
    yielded = true;
  }, 0);
  try {
    const result = await discoverCatalog(root, {
      onProgress: (snapshot) => {
        firstProgress ||= snapshot.rows.length;
      },
    });
    assert.ok(firstProgress < 10_000);
    assert.equal(result.rows.length, 10_000);
    assert.equal(yielded, true);
    assert.ok(
      [...root.children.values()].every(
        (file) => file.kind === "file" && file.reads === 0,
      ),
    );
  } finally {
    clearTimeout(timer);
  }
});

test("catalog cancellation rejects incomplete work", async () => {
  const root = new LibraryDirectory();
  root.file("first.wav");
  root.file("second.wav");
  const controller = new AbortController();
  await assert.rejects(
    discoverCatalog(root, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    { name: "AbortError" },
  );
});

test("unsupported catalog entries yield to a pending cancellation", async () => {
  const root = new LibraryDirectory();
  for (let index = 0; index < 10_000; index++) root.file(`file-${index}.mp3`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 0);
  try {
    await assert.rejects(discoverCatalog(root, { signal: controller.signal }), {
      name: "AbortError",
    });
  } finally {
    clearTimeout(timer);
  }
});
