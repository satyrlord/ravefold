import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  rename,
  symlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { LocalFolderHost } from "../scripts/local-folder-host.ts";
import { AUDIO_MANIFEST_FILENAME } from "../src/domain/audio-manifest.ts";
import { PAIR_MANIFEST_FILENAME } from "../src/domain/pair-manifest.ts";
import { SOURCE_MANIFEST_FILENAME } from "../src/domain/source-manifest.ts";
import type {
  LocalHandle,
  LocalFileInfo,
} from "../shared/local-folder-protocol.ts";
import { settingsFixture } from "./fixtures.ts";

async function fixture(writerIdleMs?: number) {
  const base = await mkdtemp(path.join(tmpdir(), "ravefold-host-"));
  const samples = path.join(base, "samples");
  const settings = path.join(base, "settings");
  await mkdir(samples);
  await mkdir(settings);
  const host = await LocalFolderHost.create(
    { samples, settings },
    { writerIdleMs },
  );
  const roots = (await host.dispatch({ op: "roots" })) as {
    samples: LocalHandle;
    settings: LocalHandle;
  };
  return {
    base,
    samples,
    settings,
    host,
    roots,
    async cleanup() {
      await host.dispose();
      await rm(base, { recursive: true, force: true });
    },
  };
}
async function child(
  host: LocalFolderHost,
  parent: LocalHandle,
  name: string,
  kind: "file" | "directory" = "file",
  create = true,
) {
  return (await host.dispatch({
    op: "child",
    handle: parent.id,
    name,
    kind,
    create,
  })) as LocalHandle;
}
async function writer(
  host: LocalFolderHost,
  file: LocalHandle,
  data: string | Buffer,
) {
  const id = (await host.dispatch({
    op: "writable",
    handle: file.id,
  })) as string;
  await host.dispatch({
    op: "write",
    writer: id,
    data: Buffer.from(data).toString("base64"),
  });
  return id;
}
function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF");
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(44100, 24);
  bytes.writeUInt32LE(88200, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  return bytes;
}

test("local host rejects unsafe names, arbitrary writes, and overlapping roots", async () => {
  const f = await fixture();
  try {
    for (const name of [
      "../escape",
      "C:\\escape",
      "x:stream",
      "CON.wav",
      "nul",
      "trailing.",
      "trailing ",
    ])
      await assert.rejects(child(f.host, f.roots.samples, name));
    await assert.rejects(child(f.host, f.roots.settings, "anything.txt"));
    await assert.rejects(
      LocalFolderHost.create({ samples: f.base, settings: f.settings }),
    );
    await assert.rejects(
      f.host.dispatch({
        op: "child",
        handle: f.roots.samples.id,
        name: null,
        kind: "file",
      } as never),
    );
    assert.deepEqual(await readdir(f.settings), []);
  } finally {
    await f.cleanup();
  }
});

test("local host writes validated settings atomically and rejects stale or competing writers", async () => {
  const f = await fixture();
  try {
    const name = "ravefold-settings.json";
    const location = path.join(f.settings, name);
    const file = await child(f.host, f.roots.settings, name);
    const data = JSON.stringify(settingsFixture());
    const id = await writer(f.host, file, data);
    await assert.rejects(f.host.dispatch({ op: "writable", handle: file.id }));
    await f.host.dispatch({ op: "close", writer: id });
    assert.equal(await readFile(location, "utf8"), data);
    const stale = await writer(f.host, file, data);
    await writeFile(location, data + "\n");
    await assert.rejects(f.host.dispatch({ op: "close", writer: stale }));
    assert.equal(await readFile(location, "utf8"), data + "\n");
    const invalid = await writer(f.host, file, "{}");
    await assert.rejects(f.host.dispatch({ op: "close", writer: invalid }));
    assert.equal(await readFile(location, "utf8"), data + "\n");
    assert.deepEqual(await readdir(f.settings), [name]);
  } finally {
    await f.cleanup();
  }
});

test("local host accepts analysis manifests only in the sample folder", async () => {
  const f = await fixture();
  try {
    for (const [name, records] of [
      [AUDIO_MANIFEST_FILENAME, "samples"],
      [PAIR_MANIFEST_FILENAME, "pairs"],
      [SOURCE_MANIFEST_FILENAME, "sources"],
    ] as const) {
      const file = await child(f.host, f.roots.samples, name);
      const valid = JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        [records]: {},
      });
      const first = await writer(f.host, file, valid);
      await f.host.dispatch({ op: "close", writer: first });
      assert.equal(await readFile(path.join(f.samples, name), "utf8"), valid);
      const invalid = await writer(f.host, file, "{}");
      await assert.rejects(f.host.dispatch({ op: "close", writer: invalid }));
      assert.equal(await readFile(path.join(f.samples, name), "utf8"), valid);
      await assert.rejects(child(f.host, f.roots.settings, name));
    }
  } finally {
    await f.cleanup();
  }
});

test("local host protects audio and publishes only complete new WAV files", async () => {
  const f = await fixture();
  try {
    const bytes = wav();
    const original = path.join(f.samples, "original.wav");
    await writeFile(original, bytes);
    const before = createHash("sha256")
      .update(await readFile(original))
      .digest("hex");
    const existing = await child(f.host, f.roots.samples, "original.wav");
    await assert.rejects(
      f.host.dispatch({ op: "writable", handle: existing.id }),
    );
    await assert.rejects(
      f.host.dispatch({
        op: "remove",
        handle: f.roots.samples.id,
        name: "original.wav",
      }),
    );
    const folder = await child(f.host, f.roots.samples, "import", "directory");
    const added = await child(f.host, folder, "new.wav");
    const id = await writer(f.host, added, bytes);
    await f.host.dispatch({ op: "close", writer: id });
    assert.deepEqual(
      await readFile(path.join(f.samples, "import", "new.wav")),
      bytes,
    );
    await assert.rejects(f.host.dispatch({ op: "writable", handle: added.id }));
    const invalid = await child(f.host, folder, "invalid.wav");
    await assert.rejects(
      f.host.dispatch({
        op: "close",
        writer: await writer(f.host, invalid, "invalid"),
      }),
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(original))
        .digest("hex"),
      before,
    );
    assert.deepEqual(await readdir(path.join(f.samples, "import")), [
      "new.wav",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("local host abort removes staging files and rejects stale bounded reads", async () => {
  const f = await fixture();
  try {
    const file = await child(
      f.host,
      f.roots.settings,
      "ravefold-settings.json",
    );
    await f.host.dispatch({
      op: "abort",
      writer: await writer(f.host, file, JSON.stringify(settingsFixture())),
    });
    assert.deepEqual(await readdir(f.settings), []);
    await writeFile(path.join(f.samples, "sample.wav"), wav());
    const sample = await child(f.host, f.roots.samples, "sample.wav");
    const info = (await f.host.dispatch({
      op: "file",
      handle: sample.id,
    })) as LocalFileInfo;
    assert.equal(
      await f.host.dispatch({
        op: "read",
        handle: sample.id,
        version: info.version,
        offset: 0,
        length: 4,
      }),
      Buffer.from("RIFF").toString("base64"),
    );
    await assert.rejects(
      f.host.dispatch({
        op: "read",
        handle: sample.id,
        version: info.version,
        offset: 0,
        length: 262145,
      }),
    );
    await writeFile(path.join(f.samples, "sample.wav"), Buffer.alloc(50));
    await assert.rejects(
      f.host.dispatch({
        op: "read",
        handle: sample.id,
        version: info.version,
        offset: 0,
        length: 4,
      }),
    );
  } finally {
    await f.cleanup();
  }
});

test("local host rejects junctions and replaced root identities", async () => {
  const f = await fixture();
  try {
    await symlink(f.settings, path.join(f.samples, "linked"), "junction");
    await assert.rejects(
      child(f.host, f.roots.samples, "linked", "directory", false),
    );
    assert.deepEqual(
      await f.host.dispatch({ op: "entries", handle: f.roots.samples.id }),
      [],
    );
    await rename(f.samples, path.join(f.base, "old-samples"));
    await mkdir(f.samples);
    await assert.rejects(
      f.host.dispatch({ op: "permission", handle: f.roots.samples.id }),
    );
  } finally {
    await f.cleanup();
  }
});

test("local host cleans only its unchanged probe manifests", async () => {
  const f = await fixture();
  try {
    const name = `.ravefold-access-${randomUUID()}.manifest.json`;
    const probe = await child(f.host, f.roots.samples, name);
    const marker = JSON.stringify({ kind: "ravefold-access-check", name });
    await f.host.dispatch({
      op: "close",
      writer: await writer(f.host, probe, marker),
    });
    await f.host.dispatch({ op: "remove", handle: f.roots.samples.id, name });
    assert.deepEqual(await readdir(f.samples), []);
    await writeFile(path.join(f.samples, name), marker);
    const unowned = await child(f.host, f.roots.samples, name);
    await assert.rejects(
      f.host.dispatch({ op: "writable", handle: unowned.id }),
    );
    await assert.rejects(
      f.host.dispatch({ op: "remove", handle: f.roots.samples.id, name }),
    );
  } finally {
    await f.cleanup();
  }
});

test("local host preserves files that appear before publication and changed probes", async () => {
  const f = await fixture();
  try {
    const folder = await child(f.host, f.roots.samples, "import", "directory");
    const file = await child(f.host, folder, "new.wav");
    const id = await writer(f.host, file, wav());
    const location = path.join(f.samples, "import", "new.wav");
    await writeFile(location, "external audio");
    await assert.rejects(f.host.dispatch({ op: "close", writer: id }));
    assert.equal(await readFile(location, "utf8"), "external audio");
    const name = `.ravefold-access-${randomUUID()}.manifest.json`;
    const probe = await child(f.host, f.roots.samples, name);
    await f.host.dispatch({
      op: "close",
      writer: await writer(
        f.host,
        probe,
        JSON.stringify({ kind: "ravefold-access-check", name }),
      ),
    });
    await writeFile(path.join(f.samples, name), "external metadata");
    await assert.rejects(
      f.host.dispatch({ op: "remove", handle: f.roots.samples.id, name }),
    );
    await f.host.dispose();
    assert.equal(
      await readFile(path.join(f.samples, name), "utf8"),
      "external metadata",
    );
  } finally {
    await f.cleanup();
  }
});

test("local host validates reservation records and removes its records on disposal", async () => {
  const f = await fixture();
  try {
    const owner = randomUUID();
    const name = `.ravefold-tags-lock-${owner}.manifest.json`;
    let reservation = await child(f.host, f.roots.samples, name);
    await assert.rejects(
      f.host.dispatch({
        op: "close",
        writer: await writer(
          f.host,
          reservation,
          JSON.stringify({
            schemaVersion: 1,
            owner: randomUUID(),
            choosing: true,
            ticket: 0,
          }),
        ),
      }),
    );
    reservation = await child(f.host, f.roots.samples, name);
    await f.host.dispatch({
      op: "close",
      writer: await writer(
        f.host,
        reservation,
        JSON.stringify({ schemaVersion: 1, owner, choosing: true, ticket: 0 }),
      ),
    });
    await f.host.dispatch({
      op: "close",
      writer: await writer(
        f.host,
        reservation,
        JSON.stringify({ schemaVersion: 1, owner, choosing: false, ticket: 1 }),
      ),
    });
    await f.host.dispose();
    assert.deepEqual(await readdir(f.samples), []);
  } finally {
    await f.cleanup();
  }
});

test("local host removes unpublished WAV handles after abort and failed close", async () => {
  const f = await fixture();
  try {
    const folder = await child(f.host, f.roots.samples, "import", "directory");
    for (const operation of ["abort", "close"] as const) {
      const file = await child(f.host, folder, "retry.wav");
      const id = await writer(f.host, file, "invalid");
      if (operation === "close")
        await assert.rejects(f.host.dispatch({ op: operation, writer: id }));
      else await f.host.dispatch({ op: operation, writer: id });
      await assert.rejects(child(f.host, folder, "retry.wav", "file", false), {
        name: "NotFoundError",
      });
    }
    const file = await child(f.host, folder, "retry.wav");
    await f.host.dispatch({
      op: "close",
      writer: await writer(f.host, file, wav()),
    });
    assert.deepEqual(
      await readFile(path.join(f.samples, "import", "retry.wav")),
      wav(),
    );
  } finally {
    await f.cleanup();
  }
});

test("local host expires abandoned writers and permits a new writer", async () => {
  const f = await fixture(80);
  try {
    const data = JSON.stringify(settingsFixture());
    const settings = await child(
      f.host,
      f.roots.settings,
      "ravefold-settings.json",
    );
    await f.host.dispatch({
      op: "close",
      writer: await writer(f.host, settings, data),
    });
    const abandoned = await writer(f.host, settings, data);
    const folder = await child(f.host, f.roots.samples, "import", "directory");
    const wavFile = await child(f.host, folder, "new.wav");
    const abandonedWav = await writer(f.host, wavFile, wav());
    await new Promise((resolve) => setTimeout(resolve, 180));
    await assert.rejects(f.host.dispatch({ op: "close", writer: abandoned }));
    await assert.rejects(
      f.host.dispatch({ op: "close", writer: abandonedWav }),
    );
    assert.equal(
      await readFile(path.join(f.settings, "ravefold-settings.json"), "utf8"),
      data,
    );
    assert.deepEqual(await readdir(path.join(f.samples, "import")), []);
    await f.host.dispatch({
      op: "close",
      writer: await writer(f.host, settings, data),
    });
    const retry = await child(f.host, folder, "new.wav");
    await f.host.dispatch({
      op: "close",
      writer: await writer(f.host, retry, wav()),
    });
    assert.deepEqual(
      await readFile(path.join(f.samples, "import", "new.wav")),
      wav(),
    );
  } finally {
    await f.cleanup();
  }
});
