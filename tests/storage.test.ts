import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkFolderSeparation,
  discoverSamples,
  probeWriteAccess,
  validateFolder,
} from "../src/storage/folders.ts";
import {
  isDirectoryHandle,
  permission,
  type AccessState,
  type DirectoryHandle,
  type FileHandle,
  type HandleBase,
  type WritableHandle,
} from "../src/storage/handles.ts";
import {
  readJson,
  SETTINGS_FILENAME,
  writeValidatedJson,
} from "../src/storage/json-files.ts";
import { resolveMissingSamples } from "../src/storage/missing.ts";
import { readRecoveryCandidates } from "../src/storage/recovery.ts";
import {
  loadFolderReferences,
  saveFolderReference,
} from "../src/storage/references.ts";

class FakeFile implements FileHandle {
  readonly kind = "file";
  name: string;
  contents: Blob;
  writes = 0;
  aborts = 0;
  failClose = false;
  failRead = false;
  beforeClose?: () => void;
  constructor(name: string, contents: Blob | string) {
    this.name = name;
    this.contents =
      typeof contents === "string" ? new Blob([contents]) : contents;
  }
  async isSameEntry(other: HandleBase): Promise<boolean> {
    return this === other;
  }
  async getFile() {
    if (this.failRead) {
      return new (class extends File {
        override async text(): Promise<string> {
          throw new DOMException("Access was revoked.", "NotAllowedError");
        }
      })([this.contents], this.name);
    }
    return new File([this.contents], this.name);
  }
  async createWritable(): Promise<WritableHandle> {
    this.writes++;
    let pending = new Blob();
    return {
      write: async (value) => {
        if (typeof value !== "string")
          throw new Error("Tests write JSON only.");
        pending = new Blob([value]);
      },
      close: async () => {
        this.beforeClose?.();
        if (this.failClose)
          throw new DOMException("Access was revoked.", "NotAllowedError");
        this.contents = pending;
      },
      abort: async () => {
        this.aborts++;
      },
    };
  }
}

class FakeDirectory implements DirectoryHandle {
  readonly kind = "directory";
  name: string;
  parent?: FakeDirectory;
  children = new Map<string, FakeDirectory | FakeFile>();
  state: AccessState = "granted";
  requested = 0;
  unreadable = false;
  removals: string[] = [];
  onCreate?: (file: FakeFile) => void;
  constructor(name: string, parent?: FakeDirectory) {
    this.name = name;
    this.parent = parent;
  }
  async isSameEntry(other: HandleBase): Promise<boolean> {
    return this === other;
  }
  async queryPermission() {
    return this.state;
  }
  async requestPermission() {
    this.requested++;
    return this.state;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.children.get(name);
    if (existing?.kind === "file") return existing;
    if (existing)
      throw new DOMException("Wrong entry type.", "TypeMismatchError");
    if (!options?.create) throw new DOMException("Missing.", "NotFoundError");
    if (this.state !== "granted")
      throw new DOMException("No access.", "NotAllowedError");
    const created = new FakeFile(name, "");
    this.children.set(name, created);
    this.onCreate?.(created);
    return created;
  }
  async getDirectoryHandle(name: string) {
    const existing = this.children.get(name);
    if (existing?.kind === "directory") return existing;
    throw new DOMException("Missing.", "NotFoundError");
  }
  async *entries(): AsyncIterableIterator<[string, FakeDirectory | FakeFile]> {
    if (this.unreadable)
      throw new DOMException("No access.", "NotAllowedError");
    yield* this.children.entries();
  }
  async resolve(handle: HandleBase): Promise<string[] | null> {
    if (handle === this) return [];
    if (!(handle instanceof FakeDirectory)) return null;
    const path: string[] = [];
    let candidate: FakeDirectory | undefined = handle;
    while (candidate?.parent) {
      path.unshift(candidate.name);
      candidate = candidate.parent;
      if (candidate === this) return path;
    }
    return null;
  }
  async removeEntry(name: string) {
    this.removals.push(name);
    this.children.delete(name);
  }
  folder(name: string) {
    const child = new FakeDirectory(name, this);
    this.children.set(name, child);
    return child;
  }
  file(name: string, contents: Blob | string) {
    const child = new FakeFile(name, contents);
    this.children.set(name, child);
    return child;
  }
}

function audio(): Blob {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    [...value].forEach((character, i) => {
      bytes[offset + i] = character.charCodeAt(0);
    });
  };
  text(0, "RIFF");
  view.setUint32(4, 38, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 44100, true);
  view.setUint32(28, 88200, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, 2, true);
  return new Blob([bytes]);
}

function validate(value: unknown): { version: 1; choice: string } {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("choice" in value) ||
    typeof value.choice !== "string"
  ) {
    throw new Error("Invalid test settings.");
  }
  return { version: 1, choice: value.choice };
}

test("folder separation rejects identical and nested directories", async () => {
  const root = new FakeDirectory("root");
  const child = root.folder("child");
  assert.equal(await checkFolderSeparation(root, root), false);
  assert.equal(await checkFolderSeparation(root, child), false);
  assert.equal(await checkFolderSeparation(child, root), false);
  assert.equal(
    await checkFolderSeparation(child, new FakeDirectory("other")),
    true,
  );
});

test("permission requests require an explicit request argument", async () => {
  const root = new FakeDirectory("root");
  root.state = "prompt";
  assert.equal(await permission(root), "prompt");
  assert.equal(root.requested, 0);
  await permission(root, true);
  assert.equal(root.requested, 1);
});

test("restored folder references require the complete directory contract", () => {
  const handle = new FakeDirectory("root");
  assert.equal(isDirectoryHandle(handle), true);
  for (const method of [
    "isSameEntry",
    "getDirectoryHandle",
    "removeEntry",
  ] as const) {
    const incomplete = new Proxy(handle, {
      get(target, key, receiver) {
        return key === method ? undefined : Reflect.get(target, key, receiver);
      },
    });
    assert.equal(isDirectoryHandle(incomplete), false, method);
  }
});

test("setup preserves audio bytes and removes only its new probe manifest", async () => {
  const root = new FakeDirectory("root");
  const sample = root.folder("nested").file("sample.wav", audio());
  const before = Buffer.from(await sample.contents.arrayBuffer());
  const result = await validateFolder(root, "samples");
  assert.equal(result.valid, true);
  assert.equal(result.discovery?.files[0]?.path, "nested/sample.wav");
  assert.deepEqual(Buffer.from(await sample.contents.arrayBuffer()), before);
  assert.equal(sample.writes, 0);
  assert.equal(root.removals.length, 1);
  assert.match(
    root.removals[0]!,
    /^\.ravefold-access-[\da-f-]+\.manifest\.json$/,
  );
});

test("only supported WAV data makes a sample folder valid", async () => {
  const root = new FakeDirectory("root");
  root.file("sample.mp3", audio());
  root.file("broken.wav", "not audio");
  const result = await validateFolder(root, "samples");
  assert.equal(result.valid, false);
  assert.equal(result.discovery?.invalid, 1);
  assert.equal(result.discovery?.unsupported, 1);
  root.state = "denied";
  assert.equal((await validateFolder(root, "samples")).valid, false);
});

test("discovery reports inaccessible children but rejects an inaccessible root", async () => {
  const root = new FakeDirectory("root");
  root.file("sample.wav", audio());
  root.folder("locked").unreadable = true;
  const result = await discoverSamples(root);
  assert.equal(result.files.length, 1);
  assert.equal(result.complete, false);
  assert.deepEqual(result.inaccessible, ["locked"]);
  root.unreadable = true;
  await assert.rejects(discoverSamples(root), { name: "NotAllowedError" });
});

test("cancelled discovery cannot report a completed selection", async () => {
  const root = new FakeDirectory("root");
  root.file("sample.wav", audio());
  root.file("later.wav", audio());
  const controller = new AbortController();
  let callbacks = 0;
  await assert.rejects(
    discoverSamples(root, {
      signal: controller.signal,
      onProgress: () => {
        callbacks++;
        controller.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(callbacks, 1);
});

test("large discovery yields so a pending cancel action can run", async () => {
  const root = new FakeDirectory("root");
  for (let i = 0; i < 1000; i++) root.file(`${i}.wav`, "invalid audio");
  const controller = new AbortController();
  const cancel = setTimeout(() => controller.abort(), 0);
  try {
    await assert.rejects(discoverSamples(root, { signal: controller.signal }), {
      name: "AbortError",
    });
  } finally {
    clearTimeout(cancel);
  }
});

test("cancelled write probe does not modify existing files", async () => {
  const root = new FakeDirectory("root");
  root.file("sample.wav", audio());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(probeWriteAccess(root, controller.signal), {
    name: "AbortError",
  });
  assert.deepEqual([...root.children.keys()], ["sample.wav"]);
});

test("corrupt settings and disguised audio are never overwritten", async () => {
  for (const contents of ["", "{invalid", audio()]) {
    const root = new FakeDirectory("root");
    const file = root.file(SETTINGS_FILENAME, contents);
    assert.equal(
      (await readJson(root, SETTINGS_FILENAME, validate)).status,
      "invalid",
    );
    await assert.rejects(
      writeValidatedJson(
        root,
        SETTINGS_FILENAME,
        { version: 1, choice: "new" },
        validate,
      ),
    );
    assert.equal(file.writes, 0);
  }
});

test("a failed metadata read reports unavailable access, not corrupt data", async () => {
  const root = new FakeDirectory("root");
  const file = root.file(
    SETTINGS_FILENAME,
    JSON.stringify({ version: 1, choice: "saved" }),
  );
  file.failRead = true;
  assert.deepEqual(await readJson(root, SETTINGS_FILENAME, validate), {
    status: "unavailable",
    message: "The file cannot be read. Check folder access.",
  });
  assert.equal(file.writes, 0);
});

test("metadata byte limits apply before parsing or writing", async () => {
  const root = new FakeDirectory("root");
  root.file(SETTINGS_FILENAME, JSON.stringify({ version: 1, choice: "saved" }));
  const result = await readJson(root, SETTINGS_FILENAME, validate, 8);
  assert.equal(result.status, "invalid");
  await assert.rejects(
    writeValidatedJson(
      root,
      SETTINGS_FILENAME,
      { version: 1, choice: "x".repeat(16384) },
      validate,
    ),
    /too large/,
  );
  await assert.rejects(
    writeValidatedJson(
      root,
      "sample.wav",
      { version: 1, choice: "x" },
      validate,
    ),
    /limited to the settings file/,
  );
  assert.equal((await root.getFileHandle(SETTINGS_FILENAME)).writes, 0);
});

test("failed settings commit aborts and preserves the last valid file", async () => {
  const root = new FakeDirectory("root");
  const previous = JSON.stringify({ version: 1, choice: "saved" });
  const file = root.file(SETTINGS_FILENAME, previous);
  file.failClose = true;
  await assert.rejects(
    writeValidatedJson(
      root,
      SETTINGS_FILENAME,
      { version: 1, choice: "new" },
      validate,
    ),
  );
  assert.equal(await file.contents.text(), previous);
  assert.equal(file.aborts, 1);
  file.failClose = false;
  await writeValidatedJson(
    root,
    SETTINGS_FILENAME,
    { version: 1, choice: "new" },
    validate,
  );
  assert.deepEqual(await readJson(root, SETTINGS_FILENAME, validate), {
    status: "valid",
    value: { version: 1, choice: "new" },
  });
});

test("a failed first settings write removes its empty target and permits retry", async () => {
  const root = new FakeDirectory("root");
  let failed: FakeFile | undefined;
  root.onCreate = (file) => {
    file.failClose = true;
    failed = file;
  };
  const value = { version: 1 as const, choice: "new" };
  await assert.rejects(
    writeValidatedJson(root, SETTINGS_FILENAME, value, validate),
  );
  assert.equal(failed?.aborts, 1);
  assert.equal(root.children.has(SETTINGS_FILENAME), false);
  assert.deepEqual(root.removals, [SETTINGS_FILENAME]);
  root.onCreate = undefined;
  await writeValidatedJson(root, SETTINGS_FILENAME, value, validate);
  assert.deepEqual(await readJson(root, SETTINGS_FILENAME, validate), {
    status: "valid",
    value,
  });
});

test("failed first-write cleanup preserves nonempty data added by another writer", async () => {
  const root = new FakeDirectory("root");
  const external = "External file contents";
  root.onCreate = (file) => {
    file.failClose = true;
    file.beforeClose = () => {
      file.contents = new Blob([external]);
    };
  };
  await assert.rejects(
    writeValidatedJson(
      root,
      SETTINGS_FILENAME,
      { version: 1, choice: "new" },
      validate,
    ),
  );
  assert.equal(
    await (await root.getFileHandle(SETTINGS_FILENAME)).contents.text(),
    external,
  );
  assert.deepEqual(root.removals, []);
});

test("failed first-write cleanup preserves a replacement file with the same name", async () => {
  const root = new FakeDirectory("root");
  let replacement: FakeFile | undefined;
  root.onCreate = (file) => {
    file.failClose = true;
    file.beforeClose = () => {
      replacement = root.file(SETTINGS_FILENAME, "");
    };
  };
  await assert.rejects(
    writeValidatedJson(
      root,
      SETTINGS_FILENAME,
      { version: 1, choice: "new" },
      validate,
    ),
  );
  assert.equal(await root.getFileHandle(SETTINGS_FILENAME), replacement);
  assert.deepEqual(root.removals, []);
});

test("recovery selection reads valid metadata without writes or deletion", async () => {
  const root = new FakeDirectory("root");
  const recovery = root.folder("recovery");
  const valid = recovery.file(
    "valid.ravefold.json",
    JSON.stringify({ version: 1, choice: "saved" }),
  );
  recovery.file("bad.ravefold.json", "bad");
  recovery.file("unrelated.txt", "other");
  const result = await readRecoveryCandidates(root, validate);
  assert.equal(result.valid.length, 1);
  assert.equal(result.invalid.length, 1);
  assert.equal(valid.writes, 0);
  assert.deepEqual(recovery.removals, []);
});

test("an unreadable recovery file reports access failure without corrupt-data status", async () => {
  const root = new FakeDirectory("root");
  const recovery = root.folder("recovery");
  recovery.file(
    "valid.ravefold.json",
    JSON.stringify({ version: 1, choice: "saved" }),
  );
  recovery.file("unreadable.ravefold.json", "{}").failRead = true;
  const result = await readRecoveryCandidates(root, validate);
  assert.deepEqual(
    result.valid.map((item) => item.filename),
    ["valid.ravefold.json"],
  );
  assert.deepEqual(result.invalid, []);
  assert.equal(
    result.unavailable,
    "Some recovery copies cannot be read. Check folder access.",
  );
});

test("missing sample paths are retained and unsafe paths cannot be read", async () => {
  const root = new FakeDirectory("root");
  root.folder("nested").file("sample.wav", audio());
  assert.deepEqual(
    await resolveMissingSamples(root, [
      "nested/sample.wav",
      "missing.wav",
      "missing.wav",
    ]),
    ["missing.wav"],
  );
  for (const path of [
    "../outside.wav",
    "/outside.wav",
    "C:/outside.wav",
    "nested\\sample.wav",
    "nested/sample.mp3",
    "nested/space /sample.wav",
  ]) {
    await assert.rejects(resolveMissingSamples(root, [path]));
  }
});

test("unavailable browser persistence has a controlled result", async () => {
  assert.equal((await loadFolderReferences()).available, false);
  assert.equal(
    (await saveFolderReference("samples", new FakeDirectory("root"))).available,
    false,
  );
});
