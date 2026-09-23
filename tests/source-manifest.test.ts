import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { registerLocalSource } from "../scripts/register-local-source.ts";
import {
  MAX_SOURCE_MANIFEST_BYTES,
  parseSourceManifest,
  SOURCE_MANIFEST_FILENAME,
  validateSourceManifest,
} from "../src/domain/source-manifest.ts";
import {
  readSourceManifest,
  verifyOfficialSource,
} from "../src/library/source-manifest.ts";
import type { WritableHandle } from "../src/storage/handles.ts";
import { LibraryDirectory, LibraryFile } from "./library-fixtures.ts";

function wavBytes(sample = 0): Uint8Array {
  const bytes = new Uint8Array(52);
  const view = new DataView(bytes.buffer);
  const mark = (offset: number, label: string) => {
    for (let index = 0; index < label.length; index++)
      view.setUint8(offset + index, label.charCodeAt(index));
  };
  mark(0, "RIFF");
  view.setUint32(4, 44, true);
  mark(8, "WAVE");
  mark(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 4_000, true);
  view.setUint32(28, 8_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  mark(36, "data");
  view.setUint32(40, 8, true);
  view.setInt16(44, sample, true);
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(bytes: Uint8Array) {
  return {
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    declared: { bpm: 180, key: "C minor" },
    provenance: "user-attested-og",
  };
}

class BinarySource extends LibraryFile {
  bytes: Uint8Array;

  constructor(name: string, bytes: Uint8Array) {
    super(name, "");
    this.bytes = bytes;
  }

  override async getFile(): Promise<File> {
    this.reads++;
    return new File([this.bytes.slice()], this.name);
  }

  override async createWritable(): Promise<WritableHandle> {
    throw new Error("Source audio must not be written.");
  }
}

async function inTemporaryFolder(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ravefold-source-"));
  try {
    await run(root);
  } finally {
    const target = resolve(root);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !/^ravefold-source-/u.test(basename(target))
    )
      throw new Error(
        "The temporary test folder is outside its expected root.",
      );
    await rm(target, { recursive: true, force: true });
  }
}

async function fixtureFolder(root: string): Promise<{
  first: Uint8Array;
  second: Uint8Array;
  metadata: Record<string, unknown>;
}> {
  const first = wavBytes(0);
  const second = wavBytes(1);
  await mkdir(join(root, "One"));
  await mkdir(join(root, "Two"));
  await writeFile(join(root, "One", "one.wav"), first);
  await writeFile(join(root, "Two", "two.wav"), second);
  const metadata = {
    source: ["user-vouched-collection"],
    total_samples: 2,
    format: {
      sample_rate: 4_000,
      bit_depth: 16,
      channels: 1,
      encoding: "mixed",
    },
    samples: [
      {
        filename: "one.wav",
        duration_sec: 0.001,
        sample_rate: 4_000,
        bit_depth: 16,
        channels: 1,
      },
      {
        filename: "two.wav",
        duration_sec: 0.001,
        sample_rate: 4_000,
        bit_depth: 16,
        channels: 1,
      },
    ],
  };
  await writeFile(join(root, "metadata.json"), JSON.stringify(metadata));
  return { first, second, metadata };
}

test("strict source schema binds only WAV paths and an exact user attestation", () => {
  const bytes = wavBytes();
  const valid = {
    schemaVersion: 1,
    revision: 0,
    sources: { "One/one.wav": record(bytes) },
  };
  assert.deepEqual(validateSourceManifest(valid), valid);
  assert.equal(validateSourceManifest({ ...valid, revision: 1 }).revision, 1);
  for (const invalid of [
    { ...valid, schemaVersion: 2 },
    { ...valid, revision: -1 },
    { ...valid, extra: true },
    { ...valid, sources: { "../one.wav": record(bytes) } },
    { ...valid, sources: { "one.mp3": record(bytes) } },
    { ...valid, sources: { "one.wav": { ...record(bytes), sha256: "bad" } } },
    { ...valid, sources: { "one.wav": { ...record(bytes), bytes: 0 } } },
    {
      ...valid,
      sources: {
        "one.wav": { ...record(bytes), declared: { bpm: 90, key: "C minor" } },
      },
    },
    {
      ...valid,
      sources: {
        "one.wav": { ...record(bytes), provenance: "filename-guess" },
      },
    },
    { ...valid, sources: { "one.wav": { ...record(bytes), audio: [1, 2] } } },
  ])
    assert.throws(() => validateSourceManifest(invalid));
  assert.throws(() =>
    parseSourceManifest("x".repeat(MAX_SOURCE_MANIFEST_BYTES + 1)),
  );
});

test("source verification needs a current hash and does not write audio", async () => {
  const root = new LibraryDirectory();
  const folder = root.folder("One");
  const bytes = wavBytes();
  const audio = new BinarySource("one.wav", bytes);
  folder.children.set(audio.name, audio);
  const manifest = {
    schemaVersion: 1,
    revision: 0,
    sources: { "One/one.wav": record(bytes) },
  };
  root.file(SOURCE_MANIFEST_FILENAME, JSON.stringify(manifest));
  const read = await readSourceManifest(root);
  assert.equal(read.status, "valid");
  const verified = await verifyOfficialSource(root, "One/one.wav");
  assert.equal(verified.verifiedOfficialSource, true);
  if (verified.verifiedOfficialSource)
    assert.deepEqual(verified.declared, {
      source: "og-collection",
      bpm: 180,
      key: "C minor",
    });
  assert.equal(audio.writes, 0);

  audio.bytes[44] = 1;
  assert.deepEqual(await verifyOfficialSource(root, "One/one.wav"), {
    verifiedOfficialSource: false,
  });
  audio.bytes = bytes.slice(0, -1);
  assert.deepEqual(await verifyOfficialSource(root, "One/one.wav"), {
    verifiedOfficialSource: false,
  });
  assert.equal(audio.writes, 0);
  assert.deepEqual(await verifyOfficialSource(root, "../one.wav"), {
    verifiedOfficialSource: false,
  });
  root.file(SOURCE_MANIFEST_FILENAME, "not JSON");
  assert.equal((await readSourceManifest(root)).status, "invalid");
  assert.deepEqual(await verifyOfficialSource(root, "One/one.wav"), {
    verifiedOfficialSource: false,
  });
});

test("dry run checks generated WAVs and metadata without a manifest write", async () => {
  await inTemporaryFolder(async (root) => {
    const { first, second } = await fixtureFolder(root);
    const before = [sha256(first), sha256(second)];
    const result = await registerLocalSource(root, { dryRun: true });
    assert.deepEqual(result, {
      files: 2,
      bytes: 104,
      dryRun: true,
      created: false,
    });
    assert.deepEqual(
      (await readdir(root)).sort(),
      ["metadata.json", "One", "Two"].sort(),
    );
    assert.deepEqual(
      [
        sha256(await readFile(join(root, "One", "one.wav"))),
        sha256(await readFile(join(root, "Two", "two.wav"))),
      ],
      before,
    );
  });
});

test("registration creates one complete manifest and preserves source WAVs", async () => {
  await inTemporaryFolder(async (root) => {
    const { first, second } = await fixtureFolder(root);
    const before = [sha256(first), sha256(second)];
    const firstRun = await registerLocalSource(root);
    assert.deepEqual(firstRun, {
      files: 2,
      bytes: 104,
      dryRun: false,
      created: true,
    });
    const text = await readFile(join(root, SOURCE_MANIFEST_FILENAME), "utf8");
    const manifest = parseSourceManifest(text);
    assert.equal(manifest.revision, 0);
    assert.deepEqual(Object.keys(manifest.sources), [
      "One/one.wav",
      "Two/two.wav",
    ]);
    assert.deepEqual(manifest.sources["One/one.wav"], record(first));
    assert.deepEqual(manifest.sources["Two/two.wav"], record(second));
    const secondRun = await registerLocalSource(root);
    assert.equal(secondRun.created, false);
    assert.equal(
      await readFile(join(root, SOURCE_MANIFEST_FILENAME), "utf8"),
      text,
    );
    assert.deepEqual(
      [
        sha256(await readFile(join(root, "One", "one.wav"))),
        sha256(await readFile(join(root, "Two", "two.wav"))),
      ],
      before,
    );
    assert.deepEqual(
      (await readdir(root)).sort(),
      ["metadata.json", "One", SOURCE_MANIFEST_FILENAME, "Two"].sort(),
    );
  });
});

test("registration preserves existing malformed or different manifests", async () => {
  for (const existing of ["not JSON", "{}"])
    await inTemporaryFolder(async (root) => {
      const { first } = await fixtureFolder(root);
      const path = join(root, SOURCE_MANIFEST_FILENAME);
      await writeFile(path, existing);
      await assert.rejects(registerLocalSource(root));
      await assert.rejects(registerLocalSource(root, { dryRun: true }));
      assert.equal(await readFile(path, "utf8"), existing);
      assert.equal(
        sha256(await readFile(join(root, "One", "one.wav"))),
        sha256(first),
      );
    });
});

test("metadata mismatches stop registration before any write", async () => {
  for (const change of [
    (row: Record<string, unknown>) => {
      row.duration_sec = 1;
    },
    (row: Record<string, unknown>) => {
      row.sample_rate = 8_000;
    },
    (row: Record<string, unknown>) => {
      row.bit_depth = 24;
    },
    (row: Record<string, unknown>) => {
      row.channels = 2;
    },
    (row: Record<string, unknown>) => {
      row.filename = "missing.wav";
    },
  ])
    await inTemporaryFolder(async (root) => {
      const { metadata } = await fixtureFolder(root);
      const samples = metadata.samples as Array<Record<string, unknown>>;
      change(samples[0]!);
      await writeFile(join(root, "metadata.json"), JSON.stringify(metadata));
      await assert.rejects(registerLocalSource(root, { dryRun: true }));
      assert.ok(!(await readdir(root)).includes(SOURCE_MANIFEST_FILENAME));
    });
});

test("registration needs collection metadata and a source identifier", async () => {
  await inTemporaryFolder(async (root) => {
    await fixtureFolder(root);
    await rm(join(root, "metadata.json"));
    await assert.rejects(registerLocalSource(root, { dryRun: true }));
    await assert.rejects(registerLocalSource(root));
    assert.ok(!(await readdir(root)).includes(SOURCE_MANIFEST_FILENAME));
  });
  await inTemporaryFolder(async (root) => {
    const { metadata } = await fixtureFolder(root);
    metadata.source = [];
    await writeFile(join(root, "metadata.json"), JSON.stringify(metadata));
    await assert.rejects(registerLocalSource(root));
    assert.ok(!(await readdir(root)).includes(SOURCE_MANIFEST_FILENAME));
  });
});
