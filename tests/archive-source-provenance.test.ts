import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { decodePxdToWav } from "../src/archive/pxd.ts";
import {
  readSourceManifest,
  saveArchiveSources,
  SOURCE_MANIFEST_FILENAME,
  verifyOfficialSource,
  type ArchiveSourceInput,
} from "../src/library/source-manifest.ts";
import type { WritableHandle } from "../src/storage/handles.ts";
import { LibraryDirectory, LibraryFile } from "./library-fixtures.ts";

function pxd(seed: number): Uint8Array<ArrayBuffer> {
  const metadata = new TextEncoder().encode("Sample\0");
  const bytes = new Uint8Array(5 + metadata.length + 7 + 4);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("tPxD"), 0);
  bytes[4] = metadata.length;
  bytes.set(metadata, 5);
  const offset = 5 + metadata.length;
  bytes[offset] = 0x54;
  view.setUint32(offset + 1, 4, true);
  bytes.set([0x81 + seed, 0x80, 0x81, 0x80], offset + 7);
  return bytes;
}

class BinarySource extends LibraryFile {
  bytes: Uint8Array<ArrayBuffer>;

  constructor(name: string, bytes: Uint8Array<ArrayBuffer>) {
    super(name, "");
    this.bytes = bytes;
  }

  override async getFile(): Promise<File> {
    this.reads++;
    return new File([this.bytes.slice()], this.name);
  }

  override async createWritable(): Promise<WritableHandle> {
    throw new Error("Archive audio must not be changed.");
  }
}

function addSource(
  root: LibraryDirectory,
  path: string,
  bytes: Uint8Array<ArrayBuffer>,
): BinarySource {
  const parts = path.split("/");
  let folder = root;
  for (const segment of parts.slice(0, -1)) {
    const existing = folder.children.get(segment);
    folder = existing?.kind === "directory" ? existing : folder.folder(segment);
  }
  const file = new BinarySource(parts.at(-1)!, bytes);
  folder.children.set(file.name, file);
  return file;
}

function input(
  path: string,
  bytes: Uint8Array<ArrayBuffer>,
): ArchiveSourceInput {
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

const firstPath = "Rave eJay ISO/RAVE/AA/FIRST.wav";
const secondPath = "Rave eJay ISO/RAVE/AA/SECOND.wav";

test("generated PXD outputs gain hash-bound archive provenance in one batch", async () => {
  const root = new LibraryDirectory();
  const firstWav = decodePxdToWav(pxd(0));
  const secondWav = decodePxdToWav(pxd(1));
  const first = addSource(root, firstPath, firstWav);
  const second = addSource(root, secondPath, secondWav);
  const rows = [input(firstPath, firstWav), input(secondPath, secondWav)];
  const saved = await saveArchiveSources(root, rows);
  assert.equal(saved.revision, 1);
  assert.equal(Object.keys(saved.sources).length, 2);
  assert.equal(saved.sources[firstPath]?.provenance, "og-archive-import");
  assert.equal(saved.sources[secondPath]?.provenance, "og-archive-import");
  assert.equal(
    (await verifyOfficialSource(root, firstPath)).verifiedOfficialSource,
    true,
  );
  assert.equal(
    (await verifyOfficialSource(root, secondPath)).verifiedOfficialSource,
    true,
  );
  const manifest = await root.getFileHandle(SOURCE_MANIFEST_FILENAME);
  const writes = manifest.writes;
  const retry = await saveArchiveSources(root, rows);
  assert.equal(retry.revision, 1);
  assert.equal(manifest.writes, writes);
  assert.equal(first.writes + second.writes, 0);
  assert.deepEqual(first.bytes, firstWav);
  assert.deepEqual(second.bytes, secondWav);
});

test("archive registration preserves a matching user-attested record", async () => {
  const root = new LibraryDirectory();
  const firstWav = decodePxdToWav(pxd(0));
  const secondWav = decodePxdToWav(pxd(1));
  addSource(root, firstPath, firstWav);
  addSource(root, secondPath, secondWav);
  const attested = {
    sha256: input(firstPath, firstWav).sha256,
    bytes: firstWav.length,
    declared: { bpm: 180, key: "C minor" },
    provenance: "user-attested-og",
  };
  root.file(
    SOURCE_MANIFEST_FILENAME,
    JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      sources: { [firstPath]: attested },
    }),
  );
  const saved = await saveArchiveSources(root, [
    input(firstPath, firstWav),
    input(secondPath, secondWav),
  ]);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.sources[firstPath], attested);
  assert.equal(saved.sources[secondPath]?.provenance, "og-archive-import");
});

test("concurrent archive batches merge without replacing one another", async () => {
  const root = new LibraryDirectory();
  const firstWav = decodePxdToWav(pxd(0));
  const secondWav = decodePxdToWav(pxd(1));
  addSource(root, firstPath, firstWav);
  addSource(root, secondPath, secondWav);
  await Promise.all([
    saveArchiveSources(root, [input(firstPath, firstWav)]),
    saveArchiveSources(root, [input(secondPath, secondWav)]),
  ]);
  const saved = await readSourceManifest(root);
  assert.equal(saved.status, "valid");
  if (saved.status !== "valid") throw new Error("Expected source manifest.");
  assert.equal(saved.value.revision, 2);
  assert.deepEqual(
    Object.keys(saved.value.sources).sort(),
    [firstPath, secondPath].sort(),
  );
});

test("an external manifest change before close is preserved", async () => {
  const root = new LibraryDirectory();
  const firstWav = decodePxdToWav(pxd(0));
  const secondWav = decodePxdToWav(pxd(1));
  addSource(root, firstPath, firstWav);
  addSource(root, secondPath, secondWav);
  await saveArchiveSources(root, [input(firstPath, firstWav)]);
  const handle = await root.getFileHandle(SOURCE_MANIFEST_FILENAME);
  const before = JSON.parse(handle.contents) as {
    sources: Record<string, unknown>;
  };
  const external = JSON.stringify({
    schemaVersion: 1,
    revision: 2,
    sources: {
      ...before.sources,
      "External/other.wav": {
        sha256: "a".repeat(64),
        bytes: 52,
        declared: { bpm: 180, key: "C minor" },
        provenance: "user-attested-og",
      },
    },
  });
  handle.onWrite = () => {
    handle.contents = external;
  };
  await assert.rejects(
    saveArchiveSources(root, [input(secondPath, secondWav)]),
    /changed in another session/u,
  );
  assert.equal(handle.contents, external);
  assert.equal(handle.active, 0);
});

test("different existing records or changed WAVs block the whole batch", async () => {
  const root = new LibraryDirectory();
  const firstWav = decodePxdToWav(pxd(0));
  const secondWav = decodePxdToWav(pxd(1));
  const first = addSource(root, firstPath, firstWav);
  const second = addSource(root, secondPath, secondWav);
  const conflict = {
    schemaVersion: 1,
    revision: 3,
    sources: {
      [firstPath]: {
        sha256: "a".repeat(64),
        bytes: firstWav.length,
        declared: { bpm: 180, key: "C minor" },
        provenance: "user-attested-og",
      },
    },
  };
  const handle = root.file(SOURCE_MANIFEST_FILENAME, JSON.stringify(conflict));
  const before = handle.contents;
  await assert.rejects(
    saveArchiveSources(root, [
      input(firstPath, firstWav),
      input(secondPath, secondWav),
    ]),
    /different audio/u,
  );
  assert.equal(handle.contents, before);
  assert.equal(handle.writes, 0);
  root.children.delete(SOURCE_MANIFEST_FILENAME);
  const rows = [input(firstPath, firstWav), input(secondPath, secondWav)];
  second.bytes[44] ^= 1;
  await assert.rejects(saveArchiveSources(root, rows), /changed/u);
  assert.equal((await readSourceManifest(root)).status, "missing");
  assert.equal(first.writes + second.writes, 0);
});

test("failed or cancelled manifest writes leave completed WAVs for retry", async () => {
  for (const failure of ["close", "cancel"] as const) {
    const root = new LibraryDirectory();
    const wav = decodePxdToWav(pxd(0));
    const audio = addSource(root, firstPath, wav);
    const controller = new AbortController();
    root.onCreate = (file) => {
      if (file.name !== SOURCE_MANIFEST_FILENAME) return;
      if (failure === "close") file.failClose = true;
      else file.onWrite = () => controller.abort();
    };
    await assert.rejects(
      saveArchiveSources(root, [input(firstPath, wav)], controller.signal),
    );
    assert.equal((await readSourceManifest(root)).status, "missing");
    assert.deepEqual(audio.bytes, wav);
    assert.equal(audio.writes, 0);
    root.onCreate = undefined;
    const saved = await saveArchiveSources(root, [input(firstPath, wav)]);
    assert.equal(saved.revision, 1);
  }
});

test("invalid or malformed source manifests are never replaced", async () => {
  const root = new LibraryDirectory();
  const wav = decodePxdToWav(pxd(0));
  addSource(root, firstPath, wav);
  const malformed = root.file(SOURCE_MANIFEST_FILENAME, "not JSON");
  await assert.rejects(saveArchiveSources(root, [input(firstPath, wav)]));
  assert.equal(malformed.contents, "not JSON");
  assert.equal(malformed.writes, 0);
  assert.throws(() => saveArchiveSources(root, []));
  assert.equal(malformed.contents, "not JSON");
});
