import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { MAX_WRITE_BYTES } from "../shared/native-protocol.ts";
import {
  NativeFiles,
  type NativeHandle,
} from "../extensions/ravefold/src/native-files.ts";

const settings = JSON.stringify({
  schemaVersion: 1,
  appearance: { skin: "reference-2", mode: "system", effects: "static" },
});

async function fixture(
  run: (fixture: {
    root: string;
    samples: string;
    settings: string;
    native: NativeFiles;
    sampleHandle: NativeHandle;
    settingsHandle: NativeHandle;
  }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "ravefold-native-test-"),
  );
  const samples = path.join(root, "samples");
  const settings = path.join(root, "settings");
  await fs.mkdir(samples);
  await fs.mkdir(settings);
  const native = new NativeFiles();
  try {
    await run({
      root,
      samples,
      settings,
      native,
      sampleHandle: await native.selectRoot("samples", samples),
      settingsHandle: await native.selectRoot("settings", settings),
    });
  } finally {
    await native.dispose();
    const canonical = path.resolve(root);
    assert.equal(path.dirname(canonical), path.resolve(os.tmpdir()));
    assert.match(path.basename(canonical), /^ravefold-native-test-/u);
    await fs.rm(canonical, { recursive: true, force: true });
  }
}

async function file(
  native: NativeFiles,
  parent: NativeHandle,
  name: string,
  create = false,
): Promise<NativeHandle> {
  return (await native.dispatch({
    op: "getFile",
    handle: parent.id,
    name,
    create,
  })) as NativeHandle;
}

async function open(
  native: NativeFiles,
  handle: NativeHandle,
): Promise<string> {
  return (
    (await native.dispatch({ op: "openWriter", handle: handle.id })) as {
      writer: string;
    }
  ).writer;
}

async function write(
  native: NativeFiles,
  handle: NativeHandle,
  data: string,
): Promise<void> {
  const writer = await open(native, handle);
  await native.dispatch({ op: "write", writer, data });
  await native.dispatch({ op: "closeWriter", writer });
}

function wav(frames = 4): Buffer {
  const dataBytes = frames * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(44_100, 24);
  bytes.writeUInt32LE(88_200, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataBytes, 40);
  for (let index = 44; index < bytes.length; index++)
    bytes[index] = index % 251;
  return bytes;
}

async function writeAudio(
  native: NativeFiles,
  handle: NativeHandle,
  bytes: Buffer,
): Promise<void> {
  const writer = await open(native, handle);
  for (let offset = 0; offset < bytes.length; offset += MAX_WRITE_BYTES) {
    await native.dispatch({
      op: "writeBytes",
      writer,
      data: bytes.subarray(offset, offset + MAX_WRITE_BYTES).toString("base64"),
    });
  }
  await native.dispatch({ op: "closeWriter", writer });
}

test("native grants expose names and opaque IDs, with no machine paths", async () => {
  await fixture(async ({ native, samples, sampleHandle }) => {
    assert.deepEqual(Object.keys(sampleHandle).sort(), ["id", "kind", "name"]);
    assert.equal(sampleHandle.name, "samples");
    assert.equal(JSON.stringify(sampleHandle).includes(samples), false);
    const stat = await fs.stat(samples);
    assert.deepEqual(native.referenceFor(sampleHandle.id), {
      role: "samples",
      path: await fs.realpath(samples),
      identity: `${stat.dev}:${stat.ino}`,
    });
    assert.equal(
      await native.dispatch({ op: "permission", handle: sampleHandle.id }),
      "granted",
    );
    await assert.rejects(native.dispatch({ op: "stat", handle: samples }), {
      name: "NotAllowedError",
    });
  });
});

test("native roots reject overlap and preserve the previous grant", async () => {
  await fixture(async ({ native, samples, settings, sampleHandle }) => {
    await fs.mkdir(path.join(samples, "child"));
    await assert.rejects(
      native.selectRoot("settings", path.join(samples, "child")),
      { name: "SecurityError" },
    );
    await assert.rejects(native.selectRoot("settings", samples), {
      name: "SecurityError",
    });
    assert.equal(native.rootPath("settings"), await fs.realpath(settings));
    assert.equal(
      await native.dispatch({ op: "permission", handle: sampleHandle.id }),
      "granted",
    );
  });
});

test("native RPC rejects malformed requests and all path traversal forms", async () => {
  await fixture(async ({ native, sampleHandle, settingsHandle }) => {
    for (const value of [
      null,
      [],
      "read",
      {},
      { op: "unknown" },
      { op: "permission", handle: sampleHandle.id, path: "extra" },
    ]) {
      await assert.rejects(native.dispatch(value), { name: "TypeError" });
    }
    for (const name of [
      "..",
      ".",
      "a/b",
      "a\\b",
      "C:\\file",
      "file:stream",
      "name\0",
      "name.",
      "name ",
      "",
    ]) {
      await assert.rejects(file(native, sampleHandle, name), {
        name: "SecurityError",
      });
    }
    await assert.rejects(
      native.dispatch({
        op: "getFile",
        handle: sampleHandle.id,
        name: "x",
        create: "yes",
      }),
      { name: "TypeError" },
    );
    await assert.rejects(
      native.dispatch({
        op: "getDirectory",
        handle: settingsHandle.id,
        name: "new",
        create: true,
      }),
      { name: "NotAllowedError" },
    );
  });
});

test("rejected creation does not leave a conflicting file handle", async () => {
  await fixture(async ({ native, samples, sampleHandle }) => {
    await assert.rejects(file(native, sampleHandle, "later", true), {
      name: "NotAllowedError",
    });
    await fs.mkdir(path.join(samples, "later"));
    const result = (await native.dispatch({
      op: "list",
      handle: sampleHandle.id,
    })) as { entries: NativeHandle[] };
    assert.deepEqual(
      result.entries.map(({ name, kind }) => ({ name, kind })),
      [{ name: "later", kind: "directory" }],
    );
  });
});

test("native reads use bounded ranges and invalidate old file snapshots", async () => {
  await fixture(async ({ native, samples, sampleHandle }) => {
    const data = Buffer.alloc(512 * 1024, 7);
    const target = path.join(samples, "sample.wav");
    await fs.writeFile(target, data);
    const handle = await file(native, sampleHandle, "sample.wav");
    const stat = (await native.dispatch({ op: "stat", handle: handle.id })) as {
      size: number;
      version: string;
    };
    assert.equal(stat.size, data.length);
    const read = (await native.dispatch({
      op: "read",
      handle: handle.id,
      version: stat.version,
      offset: 128,
      length: 256 * 1024,
    })) as { data: string };
    assert.deepEqual(
      Buffer.from(read.data, "base64"),
      data.subarray(128, 128 + 256 * 1024),
    );
    for (const length of [-1, 256 * 1024 + 1, Infinity, "1"]) {
      await assert.rejects(
        native.dispatch({
          op: "read",
          handle: handle.id,
          version: stat.version,
          offset: 0,
          length,
        }),
        { name: "TypeError" },
      );
    }
    await fs.appendFile(target, "x");
    await assert.rejects(
      native.dispatch({
        op: "read",
        handle: handle.id,
        version: stat.version,
        offset: 0,
        length: 2,
      }),
      { name: "InvalidStateError" },
    );
  });
});

test("native enumeration uses pages and closes cancelled cursors", async () => {
  await fixture(async ({ native, samples, sampleHandle, settingsHandle }) => {
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        fs.writeFile(path.join(samples, `${index}.wav`), "audio"),
      ),
    );
    const first = (await native.dispatch({
      op: "list",
      handle: sampleHandle.id,
      limit: 2,
    })) as { entries: NativeHandle[]; cursor: string };
    assert.equal(first.entries.length, 2);
    assert.equal(
      first.entries.every((entry) => entry.kind === "file"),
      true,
    );
    await assert.rejects(
      native.dispatch({
        op: "list",
        handle: settingsHandle.id,
        cursor: first.cursor,
      }),
      { name: "InvalidStateError" },
    );
    const next = (await native.dispatch({
      op: "list",
      handle: sampleHandle.id,
      cursor: first.cursor,
      limit: 2,
    })) as { entries: NativeHandle[]; cursor: string };
    assert.equal(next.entries.length, 2);
    await native.dispatch({ op: "closeList", cursor: next.cursor });
    await assert.rejects(
      native.dispatch({
        op: "list",
        handle: sampleHandle.id,
        cursor: next.cursor,
      }),
      { name: "InvalidStateError" },
    );
    await assert.rejects(
      native.dispatch({ op: "list", handle: sampleHandle.id, limit: 257 }),
      { name: "TypeError" },
    );
  });
});

test("native enumeration reuses handles across a large real folder", async (t) => {
  await fixture(async ({ native, samples, sampleHandle }) => {
    const count = 1024;
    for (let start = 0; start < count; start += 64) {
      await Promise.all(
        Array.from({ length: 64 }, (_, offset) =>
          fs.writeFile(
            path.join(samples, `sample-${start + offset}.wav`),
            "audio",
          ),
        ),
      );
    }
    async function enumerate(root: NativeHandle): Promise<NativeHandle[]> {
      const handles: NativeHandle[] = [];
      let cursor: string | undefined;
      do {
        const page = (await native.dispatch({
          op: "list",
          handle: root.id,
          cursor,
          limit: 256,
        })) as { entries: NativeHandle[]; cursor?: string };
        handles.push(...page.entries);
        cursor = page.cursor;
      } while (cursor);
      return handles;
    }
    const start = performance.now();
    const first = await enumerate(sampleHandle);
    t.diagnostic(
      `Listed ${count} real files in ${Math.round(performance.now() - start)} ms.`,
    );
    assert.equal(first.length, count);
    const ids = new Map(first.map((entry) => [entry.name, entry.id]));
    const second = await enumerate(sampleHandle);
    assert.equal(second.length, count);
    assert.equal(
      second.every((entry) => ids.get(entry.name) === entry.id),
      true,
    );
    const named = await file(native, sampleHandle, "sample-0.wav");
    assert.equal(named.id, ids.get(named.name));

    const replacement = await native.selectRoot("samples", samples);
    await assert.rejects(native.dispatch({ op: "stat", handle: named.id }), {
      name: "NotAllowedError",
    });
    const fresh = await file(native, replacement, named.name);
    assert.notEqual(fresh.id, named.id);
  });
});

test(
  "native enumeration skips unsupported disk names",
  { skip: process.platform === "win32" },
  async () => {
    await fixture(async ({ native, samples, sampleHandle }) => {
      await fs.writeFile(path.join(samples, "bad:name"), "other");
      await fs.writeFile(path.join(samples, "good.wav"), "audio");
      const result = (await native.dispatch({
        op: "list",
        handle: sampleHandle.id,
      })) as { entries: NativeHandle[] };
      assert.deepEqual(
        result.entries.map((entry) => entry.name),
        ["good.wav"],
      );
      await assert.rejects(file(native, sampleHandle, "bad:name"), {
        name: "SecurityError",
      });
    });
  },
);

test("native range reads complete after short file reads", async (t) => {
  await fixture(async ({ native, samples, sampleHandle }) => {
    const data = Buffer.from(
      "A full file range needs more than one short read.",
    );
    const target = path.join(samples, "short.wav");
    await fs.writeFile(target, data);
    const handle = await file(native, sampleHandle, "short.wav");
    const stat = (await native.dispatch({ op: "stat", handle: handle.id })) as {
      version: string;
    };
    const opened = await fs.open(target, "r");
    type ReadMethod = (
      this: typeof opened,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => Promise<{ bytesRead: number; buffer: Buffer }>;
    const prototype = Object.getPrototypeOf(opened) as { read: ReadMethod };
    const originalRead = prototype.read;
    await opened.close();
    let calls = 0;
    t.mock.method(
      prototype,
      "read",
      function (
        this: typeof opened,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) {
        calls++;
        return originalRead.call(
          this,
          buffer,
          offset,
          Math.min(length, 3),
          position,
        );
      },
    );
    const result = (await native.dispatch({
      op: "read",
      handle: handle.id,
      version: stat.version,
      offset: 0,
      length: data.length,
    })) as { data: string };
    assert.deepEqual(Buffer.from(result.data, "base64"), data);
    assert.ok(calls > 1);
  });
});

test("native descendants resolve within their selected root", async () => {
  await fixture(async ({ native, samples, sampleHandle, settingsHandle }) => {
    await fs.mkdir(path.join(samples, "drums"));
    await fs.writeFile(path.join(samples, "drums", "kick.wav"), "audio");
    const directory = (await native.dispatch({
      op: "getDirectory",
      handle: sampleHandle.id,
      name: "drums",
    })) as NativeHandle;
    const handle = await file(native, directory, "kick.wav");
    assert.deepEqual(
      await native.dispatch({
        op: "resolve",
        handle: sampleHandle.id,
        other: handle.id,
      }),
      ["drums", "kick.wav"],
    );
    assert.equal(
      await native.dispatch({
        op: "resolve",
        handle: settingsHandle.id,
        other: handle.id,
      }),
      null,
    );
    assert.equal(
      await native.dispatch({
        op: "same",
        handle: handle.id,
        other: handle.id,
      }),
      true,
    );
    await assert.rejects(file(native, sampleHandle, "drums"), {
      name: "TypeMismatchError",
    });
  });
});

test("native sample audio remains byte-identical after rejected mutation paths", async () => {
  await fixture(async ({ native, samples, sampleHandle }) => {
    const source = Buffer.from("RIFF----WAVEexisting-audio");
    const audio = path.join(samples, "sample.wav");
    await fs.writeFile(audio, source);
    const before = createHash("sha256")
      .update(await fs.readFile(audio))
      .digest("hex");
    const handle = await file(native, sampleHandle, "sample.wav", true);
    await assert.rejects(open(native, handle), { name: "NotAllowedError" });
    await assert.rejects(
      native.dispatch({
        op: "remove",
        handle: sampleHandle.id,
        name: "sample.wav",
      }),
      { name: "NotAllowedError" },
    );
    await assert.rejects(file(native, sampleHandle, "new.pxd", true), {
      name: "NotAllowedError",
    });
    await assert.rejects(
      file(native, sampleHandle, "ravefold-settings.json", true),
      { name: "NotAllowedError" },
    );
    assert.equal(
      createHash("sha256")
        .update(await fs.readFile(audio))
        .digest("hex"),
      before,
    );
    assert.deepEqual(await fs.readdir(samples), ["sample.wav"]);
  });
});

test("native host adds validated WAV files in new sample subfolders", async () => {
  await fixture(async ({ native, samples, sampleHandle, settingsHandle }) => {
    const archive = (await native.dispatch({
      op: "getDirectory",
      handle: sampleHandle.id,
      name: "Archived",
      create: true,
    })) as NativeHandle;
    const drums = (await native.dispatch({
      op: "getDirectory",
      handle: archive.id,
      name: "Drums",
      create: true,
    })) as NativeHandle;
    const again = (await native.dispatch({
      op: "getDirectory",
      handle: archive.id,
      name: "Drums",
      create: true,
    })) as NativeHandle;
    assert.equal(again.id, drums.id);
    assert.deepEqual(
      await native.dispatch({
        op: "resolve",
        handle: sampleHandle.id,
        other: drums.id,
      }),
      ["Archived", "Drums"],
    );
    await assert.rejects(
      native.dispatch({
        op: "getDirectory",
        handle: settingsHandle.id,
        name: "Audio",
        create: true,
      }),
      { name: "NotAllowedError" },
    );
    const contents = wav(150_000);
    const handle = await file(native, drums, "kick.wav", true);
    await writeAudio(native, handle, contents);
    const target = path.join(samples, "Archived", "Drums", "kick.wav");
    assert.equal(
      createHash("sha256")
        .update(await fs.readFile(target))
        .digest("hex"),
      createHash("sha256").update(contents).digest("hex"),
    );
    assert.deepEqual(await fs.readdir(samples), ["Archived"]);
    assert.deepEqual(await fs.readdir(path.dirname(target)), ["kick.wav"]);
    await assert.rejects(open(native, handle), { name: "NotAllowedError" });
    await assert.rejects(
      native.dispatch({ op: "remove", handle: drums.id, name: "kick.wav" }),
      { name: "NotAllowedError" },
    );
  });
});

test("native WAV writes preserve collisions and allow a new name on retry", async () => {
  await fixture(async ({ native, samples, sampleHandle }) => {
    const original = wav(8);
    const occupied = path.join(samples, "occupied.wav");
    await fs.writeFile(occupied, original);
    const existing = await file(native, sampleHandle, "occupied.wav", true);
    await assert.rejects(open(native, existing), { name: "NotAllowedError" });

    const race = await file(native, sampleHandle, "race.wav", true);
    const writer = await open(native, race);
    await native.dispatch({
      op: "writeBytes",
      writer,
      data: wav(12).toString("base64"),
    });
    const external = wav(16);
    await fs.writeFile(path.join(samples, "race.wav"), external);
    await assert.rejects(native.dispatch({ op: "closeWriter", writer }), {
      name: "InvalidModificationError",
    });
    assert.deepEqual(await fs.readFile(occupied), original);
    assert.deepEqual(
      await fs.readFile(path.join(samples, "race.wav")),
      external,
    );
    assert.deepEqual((await fs.readdir(samples)).sort(), [
      "occupied.wav",
      "race.wav",
    ]);

    const retry = await file(native, sampleHandle, "retry.wav", true);
    await writeAudio(native, retry, original);
    assert.deepEqual(
      await fs.readFile(path.join(samples, "retry.wav")),
      original,
    );
  });
});

test("native WAV writers reject invalid chunks and invalid audio without output", async () => {
  await fixture(async ({ native, samples, sampleHandle, settingsHandle }) => {
    await assert.rejects(file(native, settingsHandle, "audio.wav", true), {
      name: "NotAllowedError",
    });
    const handle = await file(native, sampleHandle, "invalid.wav", true);
    const writer = await open(native, handle);
    for (const data of ["@@@", "Zg=", "A".repeat(400_000)]) {
      await assert.rejects(
        native.dispatch({ op: "writeBytes", writer, data }),
        {
          name: "TypeError",
        },
      );
    }
    await assert.rejects(
      native.dispatch({ op: "write", writer, data: "RIFF" }),
      { name: "NotAllowedError" },
    );
    await native.dispatch({
      op: "writeBytes",
      writer,
      data: Buffer.from("RIFF----WAVEnot-a-valid-file").toString("base64"),
    });
    await assert.rejects(native.dispatch({ op: "closeWriter", writer }), {
      name: "TypeError",
    });
    assert.deepEqual(await fs.readdir(samples), []);
    await writeAudio(native, handle, wav());
    assert.deepEqual(await fs.readdir(samples), ["invalid.wav"]);
    const later = await file(native, sampleHandle, "aborted.wav", true);
    const aborted = await open(native, later);
    await native.dispatch({
      op: "writeBytes",
      writer: aborted,
      data: wav().toString("base64"),
    });
    await native.dispatch({ op: "abortWriter", writer: aborted });
    assert.deepEqual(await fs.readdir(samples), ["invalid.wav"]);
  });
});

test("native grant replacement removes an unfinished WAV stage", async () => {
  await fixture(async ({ native, samples, sampleHandle }) => {
    const handle = await file(native, sampleHandle, "unfinished.wav", true);
    const writer = await open(native, handle);
    await native.dispatch({
      op: "writeBytes",
      writer,
      data: wav().toString("base64"),
    });
    await native.selectRoot("samples", samples);
    assert.deepEqual(await fs.readdir(samples), []);
    await assert.rejects(native.dispatch({ op: "closeWriter", writer }), {
      name: "InvalidStateError",
    });
  });
});

test("native lookup ignores an aborted pending WAV and permits retry", async () => {
  await fixture(async ({ native, samples, sampleHandle }) => {
    const pending = await file(native, sampleHandle, "retry.wav", true);
    const writer = await open(native, pending);
    await native.dispatch({
      op: "writeBytes",
      writer,
      data: wav().toString("base64"),
    });
    await native.dispatch({ op: "abortWriter", writer });
    assert.deepEqual(await fs.readdir(samples), []);
    await assert.rejects(file(native, sampleHandle, "retry.wav"), {
      name: "NotFoundError",
    });
    const retry = await file(native, sampleHandle, "retry.wav", true);
    assert.equal(retry.id, pending.id);
    const contents = wav(10);
    await writeAudio(native, retry, contents);
    assert.deepEqual(
      await fs.readFile(path.join(samples, "retry.wav")),
      contents,
    );
    assert.equal(
      (await file(native, sampleHandle, "retry.wav")).id,
      pending.id,
    );
  });
});

test("native probe writes require exact content and session ownership", async () => {
  await fixture(async ({ native, samples, sampleHandle }) => {
    const name = `.ravefold-access-${randomUUID()}.manifest.json`;
    const handle = await file(native, sampleHandle, name, true);
    const writer = await open(native, handle);
    await assert.rejects(
      native.dispatch({ op: "write", writer, data: "RIFF audio" }),
      { name: "NotAllowedError" },
    );
    const marker = JSON.stringify({ kind: "ravefold-access-check", name });
    await native.dispatch({ op: "write", writer, data: marker });
    await native.dispatch({ op: "closeWriter", writer });
    assert.equal(await fs.readFile(path.join(samples, name), "utf8"), marker);
    await native.dispatch({ op: "remove", handle: sampleHandle.id, name });
    assert.deepEqual(await fs.readdir(samples), []);
    await fs.writeFile(path.join(samples, name), marker);
    const existing = await file(native, sampleHandle, name);
    await assert.rejects(open(native, existing), { name: "NotAllowedError" });
    await assert.rejects(
      native.dispatch({ op: "remove", handle: sampleHandle.id, name }),
      { name: "NotAllowedError" },
    );
    assert.equal(await fs.readFile(path.join(samples, name), "utf8"), marker);
  });
});

test("native probe removal preserves a changed or replaced file", async () => {
  await fixture(async ({ native, samples, sampleHandle }) => {
    const name = `.ravefold-access-${randomUUID()}.manifest.json`;
    const handle = await file(native, sampleHandle, name, true);
    await write(
      native,
      handle,
      JSON.stringify({ kind: "ravefold-access-check", name }),
    );
    await fs.writeFile(path.join(samples, name), "RIFF audio");
    await assert.rejects(
      native.dispatch({ op: "remove", handle: sampleHandle.id, name }),
      { name: "NotAllowedError" },
    );
    assert.equal(
      await fs.readFile(path.join(samples, name), "utf8"),
      "RIFF audio",
    );
  });
});

test("native probe removal preserves a file changed without changing its text", async () => {
  await fixture(async ({ native, samples, sampleHandle }) => {
    const name = `.ravefold-access-${randomUUID()}.manifest.json`;
    const target = path.join(samples, name);
    const marker = JSON.stringify({ kind: "ravefold-access-check", name });
    const handle = await file(native, sampleHandle, name, true);
    await write(native, handle, marker);
    const original = await fs.stat(target);
    await fs.utimes(
      target,
      original.atime,
      new Date(original.mtimeMs + 60_000),
    );
    assert.equal(await fs.readFile(target, "utf8"), marker);
    await assert.rejects(
      native.dispatch({ op: "remove", handle: sampleHandle.id, name }),
      { name: "NotAllowedError" },
    );
    assert.equal(await fs.readFile(target, "utf8"), marker);
  });
});

test("native settings writes validate both old and new content", async () => {
  await fixture(async ({ native, settings: folder, settingsHandle }) => {
    const target = path.join(folder, "ravefold-settings.json");
    const handle = await file(
      native,
      settingsHandle,
      "ravefold-settings.json",
      true,
    );
    await write(native, handle, settings);
    assert.equal(await fs.readFile(target, "utf8"), settings);
    const changed = settings.replace("reference-2", "reference-4");
    await write(native, handle, changed);
    assert.equal(await fs.readFile(target, "utf8"), changed);
    await assert.rejects(
      native.dispatch({
        op: "remove",
        handle: settingsHandle.id,
        name: "ravefold-settings.json",
      }),
      { name: "NotAllowedError" },
    );
    await fs.writeFile(target, "RIFF----WAVEaudio disguised as JSON");
    await assert.rejects(open(native, handle));
    assert.equal(
      await fs.readFile(target, "utf8"),
      "RIFF----WAVEaudio disguised as JSON",
    );
    assert.deepEqual(await fs.readdir(folder), ["ravefold-settings.json"]);
  });
});

test("native settings preserve external changes and reject concurrent writers", async () => {
  await fixture(async ({ native, settings: folder, settingsHandle }) => {
    const target = path.join(folder, "ravefold-settings.json");
    await fs.writeFile(target, settings);
    const handle = await file(native, settingsHandle, "ravefold-settings.json");
    const writer = await open(native, handle);
    await assert.rejects(open(native, handle), { name: "InvalidStateError" });
    await native.dispatch({
      op: "write",
      writer,
      data: settings.replace("reference-2", "reference-3"),
    });
    const external = settings.replace("reference-2", "reference-6");
    await fs.writeFile(target, external);
    await assert.rejects(native.dispatch({ op: "closeWriter", writer }), {
      name: "InvalidModificationError",
    });
    assert.equal(await fs.readFile(target, "utf8"), external);
    assert.deepEqual(await fs.readdir(folder), ["ravefold-settings.json"]);
  });
});

test("native cancellation and disposal leave no new settings or probe files", async () => {
  await fixture(async ({ native, settings: folder, settingsHandle }) => {
    const handle = await file(
      native,
      settingsHandle,
      "ravefold-settings.json",
      true,
    );
    const writer = await open(native, handle);
    await native.dispatch({ op: "write", writer, data: settings });
    await native.dispatch({ op: "abortWriter", writer });
    await native.dispatch({
      op: "remove",
      handle: settingsHandle.id,
      name: "ravefold-settings.json",
    });
    assert.deepEqual(await fs.readdir(folder), []);
    const pending = await file(
      native,
      settingsHandle,
      "ravefold-settings.json",
      true,
    );
    const unfinished = await open(native, pending);
    await native.dispatch({ op: "write", writer: unfinished, data: settings });
    await native.dispose();
    await assert.rejects(
      native.dispatch({ op: "closeWriter", writer: unfinished }),
      { name: "AbortError" },
    );
    assert.deepEqual(await fs.readdir(folder), []);
  });
});

test("native grants reject junction escapes and detect replaced roots", async () => {
  await fixture(async ({ native, root, samples, sampleHandle }) => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "private.wav"), "private");
    await fs.symlink(
      outside,
      path.join(samples, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      native.dispatch({
        op: "getDirectory",
        handle: sampleHandle.id,
        name: "escape",
      }),
      { name: "SecurityError" },
    );
    const listing = (await native.dispatch({
      op: "list",
      handle: sampleHandle.id,
    })) as { entries: NativeHandle[] };
    assert.deepEqual(listing.entries, []);
    await fs.rename(samples, path.join(root, "original"));
    await fs.symlink(
      outside,
      samples,
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.equal(
      await native.dispatch({ op: "permission", handle: sampleHandle.id }),
      "denied",
    );
    await assert.rejects(file(native, sampleHandle, "private.wav"), {
      name: "SecurityError",
    });
  });
});

test("native restoration rechecks roots and selection revokes old handles", async () => {
  await fixture(async ({ native, root, samples, sampleHandle }) => {
    const reference = native.referenceFor(sampleHandle.id);
    const restored = await native.restoreRoot(
      "samples",
      reference.path,
      reference.identity,
    );
    assert.equal(restored.name, "samples");
    await assert.rejects(
      native.dispatch({ op: "permission", handle: sampleHandle.id }),
      { name: "NotAllowedError" },
    );
    const next = path.join(root, "next");
    await fs.mkdir(next);
    await native.selectRoot("samples", next);
    await assert.rejects(native.dispatch({ op: "list", handle: restored.id }), {
      name: "NotAllowedError",
    });
    await assert.rejects(
      native.restoreRoot(
        "samples",
        path.join(root, "missing"),
        reference.identity,
      ),
    );
    assert.equal(native.rootPath("samples"), await fs.realpath(next));
  });
});

test("native saved references reject a replacement folder between sessions", async () => {
  await fixture(async ({ native, root, samples, sampleHandle }) => {
    const reference = native.referenceFor(sampleHandle.id);
    await native.dispose();
    const restoredSession = new NativeFiles();
    try {
      const original = await restoredSession.restoreRoot(
        "samples",
        reference.path,
        reference.identity,
      );
      assert.equal(original.name, "samples");
      await fs.rename(samples, path.join(root, "original"));
      await fs.mkdir(samples);
      const freshSession = new NativeFiles();
      try {
        await assert.rejects(
          freshSession.restoreRoot(
            "samples",
            reference.path,
            reference.identity,
          ),
          { name: "SecurityError" },
        );
        assert.equal(freshSession.rootPath("samples"), undefined);
        const explicit = await freshSession.selectRoot("samples", samples);
        assert.notEqual(
          freshSession.referenceFor(explicit.id).identity,
          reference.identity,
        );
        assert.equal(
          await freshSession.dispatch({
            op: "permission",
            handle: explicit.id,
          }),
          "granted",
        );
      } finally {
        await freshSession.dispose();
      }
    } finally {
      await restoredSession.dispose();
    }
  });
});

test("native saved references reject a junction even when it targets the original folder", async () => {
  await fixture(async ({ native, root, samples, sampleHandle }) => {
    const reference = native.referenceFor(sampleHandle.id);
    await native.dispose();
    const original = path.join(root, "original");
    await fs.rename(samples, original);
    await fs.symlink(
      original,
      samples,
      process.platform === "win32" ? "junction" : "dir",
    );
    const restoredSession = new NativeFiles();
    try {
      await assert.rejects(
        restoredSession.restoreRoot(
          "samples",
          reference.path,
          reference.identity,
        ),
        { name: "SecurityError" },
      );
      assert.equal(restoredSession.rootPath("samples"), undefined);
      const explicit = await restoredSession.selectRoot("samples", samples);
      assert.equal(
        restoredSession.referenceFor(explicit.id).path,
        await fs.realpath(original),
      );
      assert.equal(
        await restoredSession.dispatch({
          op: "permission",
          handle: explicit.id,
        }),
        "granted",
      );
    } finally {
      await restoredSession.dispose();
    }
  });
});
