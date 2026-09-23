import assert from "node:assert/strict";
import { test } from "node:test";
import { LibraryController } from "../src/library/controller.ts";
import {
  parseTagManifest,
  saveSampleTags,
  TAGS_FILENAME,
  type TagManifest,
} from "../src/library/tags.ts";
import { LibraryDirectory, LibraryFile } from "./library-fixtures.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function wav(channels: 1 | 2 = 1): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + channels * 8);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  write(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 48000 * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, channels * 8, true);
  return bytes;
}

function source(root: LibraryDirectory, name: string, channels: 1 | 2 = 1) {
  const file = root.file(name);
  file.getFile = async () => {
    file.reads++;
    return new File([wav(channels)], name);
  };
  return file;
}

function manifest(root: LibraryDirectory, tags: Record<string, string[]>) {
  const value: TagManifest = {
    schemaVersion: 1,
    revision: 1,
    samples: Object.fromEntries(
      Object.entries(tags).map(([path, tags]) => [path, { tags }]),
    ),
  };
  return root.file(TAGS_FILENAME, JSON.stringify(value));
}

function holdWrite(file: LibraryFile) {
  const pending = gate();
  const reached = gate();
  const create = file.createWritable.bind(file);
  file.createWritable = async () => {
    const writer = await create();
    return {
      ...writer,
      write: async (data, signal) => {
        await writer.write(data, signal);
        reached.release();
        await pending.promise;
      },
    };
  };
  return { release: pending.release, reached: reached.promise };
}

function holdNextRead(file: LibraryFile) {
  const pending = gate();
  const reached = gate();
  const read = file.getFile.bind(file);
  let next = true;
  file.getFile = async () => {
    const snapshot = await read();
    if (!next) return snapshot;
    next = false;
    reached.release();
    return new (class extends File {
      override async text(): Promise<string> {
        await pending.promise;
        return snapshot.text();
      }
    })([snapshot], file.name);
  };
  return { release: pending.release, reached: reached.promise };
}

function regrant(previous: LibraryDirectory): LibraryDirectory {
  const next = new LibraryDirectory(previous.name);
  const sameRoot = async (other: unknown) =>
    other === previous || other === next;
  previous.isSameEntry = sameRoot;
  next.isSameEntry = sameRoot;
  for (const [name, file] of previous.children) {
    assert.equal(file.kind, "file");
    if (file.kind !== "file") continue;
    const replacement = /\.wav$/i.test(name)
      ? source(next, name)
      : next.file(name);
    const sameFile = async (other: unknown) =>
      other === file || other === replacement;
    file.isSameEntry = sameFile;
    replacement.isSameEntry = sameFile;
    Object.defineProperty(replacement, "contents", {
      get: () => file.contents,
      set: (value: string) => {
        file.contents = value;
      },
    });
    file.getFile = async () => {
      throw new DOMException(
        "The old grant is unavailable.",
        "NotAllowedError",
      );
    };
  }
  previous.state = "denied";
  previous.getFileHandle = async () => {
    throw new DOMException("The old grant is unavailable.", "NotAllowedError");
  };
  return next;
}

test("controller loads path-specific saved tags without reading sample audio", async () => {
  const root = new LibraryDirectory();
  const one = source(root.folder("one"), "kick.wav");
  const two = source(root.folder("two"), "kick.wav");
  manifest(root, { "one/kick.wav": ["Hard"], "two/kick.wav": ["Soft"] });
  const controller = new LibraryController(root);
  await controller.start();
  assert.equal(controller.getSnapshot().loading, false);
  assert.equal(controller.getSnapshot().catalog.rows.length, 2);
  assert.deepEqual(controller.tags("one/kick.wav"), ["Hard"]);
  assert.deepEqual(controller.tags("two/kick.wav"), ["Soft"]);
  assert.equal(one.reads + two.reads, 0);
  controller.dispose();
});

test("an oversized source stays in review without a full audio read", async () => {
  const root = new LibraryDirectory();
  const file = root.file("large.wav");
  let slices = 0;
  file.getFile = async () =>
    new (class extends File {
      override get size(): number {
        return 101 * 1024 * 1024;
      }
      override slice(): Blob {
        slices++;
        throw new Error("The oversized source must not be read.");
      }
    })([], "large.wav");
  const controller = new LibraryController(root);
  await controller.start();
  await controller.select("large.wav");
  assert.equal(controller.getSnapshot().analysis?.status, "needs-review");
  assert.match(controller.getSnapshot().analysis?.message ?? "", /100 MiB/u);
  assert.equal(slices, 0);
  controller.dispose();
});

test("late file metadata and read errors cannot replace the latest selection", async () => {
  for (const fail of [false, true]) {
    const root = new LibraryDirectory();
    const slow = source(root, "slow.wav");
    source(root, "current.wav", 2);
    const pending = gate();
    slow.getFile = async () => {
      await pending.promise;
      if (fail) throw new Error("The old source is unavailable.");
      return new File(["invalid earlier audio"], slow.name);
    };
    const controller = new LibraryController(root);
    await controller.start();
    const previous = controller.select("slow.wav");
    await controller.select("current.wav");
    pending.release();
    await previous;
    assert.equal(controller.getSnapshot().selected, "current.wav");
    assert.equal(controller.getSnapshot().metadata?.channels, 2);
    assert.equal(controller.getSnapshot().metadataMessage, "");
    controller.dispose();
  }
});

test("a pending tag save stays with its path after selection changes", async () => {
  const root = new LibraryDirectory();
  source(root, "one.wav");
  source(root, "two.wav");
  const file = manifest(root, { "one.wav": ["Old"], "two.wav": ["Other"] });
  const pending = holdWrite(file);
  const controller = new LibraryController(root);
  await controller.start();
  await controller.select("one.wav");
  controller.editTags("one.wav", ["New"]);
  const save = controller.saveTags("one.wav");
  await pending.reached;
  await controller.select("two.wav");
  controller.editTags("two.wav", ["Second draft"]);
  assert.equal(controller.getSnapshot().tagStatus["one.wav"], "saving");
  assert.equal(controller.getSnapshot().tagStatus["two.wav"], "unsaved");
  pending.release();
  await save;
  assert.equal(controller.getSnapshot().selected, "two.wav");
  assert.equal(controller.getSnapshot().tagStatus["one.wav"], "saved");
  assert.equal(controller.getSnapshot().tagStatus["two.wav"], "unsaved");
  assert.deepEqual(controller.tags("one.wav"), ["New"]);
  assert.deepEqual(controller.tags("two.wav"), ["Second draft"]);
  assert.deepEqual(parseTagManifest(file.contents).samples["two.wav"].tags, [
    "Other",
  ]);
  controller.dispose();
});

test("duplicate saves and edits during a write cannot overlap or alter the saved draft", async () => {
  const root = new LibraryDirectory();
  source(root, "sample.wav");
  const file = manifest(root, { "sample.wav": ["Old"] });
  const pending = holdWrite(file);
  const controller = new LibraryController(root);
  await controller.start();
  controller.editTags("sample.wav", ["New"]);
  const first = controller.saveTags("sample.wav");
  await pending.reached;
  await controller.saveTags("sample.wav");
  controller.editTags("sample.wav", ["Ignored during save"]);
  assert.equal(file.writes, 1);
  assert.equal(file.active, 1);
  assert.deepEqual(controller.tags("sample.wav"), ["New"]);
  pending.release();
  await first;
  assert.equal(file.writes, 1);
  assert.equal(file.active, 0);
  assert.equal(controller.getSnapshot().tagStatus["sample.wav"], "saved");
  assert.deepEqual(parseTagManifest(file.contents).samples["sample.wav"].tags, [
    "New",
  ]);
  controller.dispose();
});

test("failed tag saves retain the draft and previous record until a successful retry", async () => {
  const root = new LibraryDirectory();
  source(root, "sample.wav");
  const file = manifest(root, { "sample.wav": ["Old"] });
  const previous = file.contents;
  const controller = new LibraryController(root);
  await controller.start();
  controller.editTags("sample.wav", ["New"]);
  file.failClose = true;
  await controller.saveTags("sample.wav");
  assert.equal(controller.getSnapshot().tagStatus["sample.wav"], "error");
  assert.match(controller.getSnapshot().tagErrors["sample.wav"], /denied/);
  assert.deepEqual(controller.tags("sample.wav"), ["New"]);
  assert.equal(file.contents, previous);
  file.failClose = false;
  await controller.saveTags("sample.wav");
  assert.equal(controller.getSnapshot().tagStatus["sample.wav"], "saved");
  assert.equal(controller.getSnapshot().tagErrors["sample.wav"], "");
  controller.dispose();
  const reloaded = new LibraryController(root);
  await reloaded.start();
  assert.deepEqual(reloaded.tags("sample.wav"), ["New"]);
  assert.equal(reloaded.getSnapshot().message, "");
  reloaded.dispose();
});

test("a failed manifest read remains visible and never authorizes replacement", async () => {
  for (const failure of ["invalid", "unavailable"] as const) {
    const root = new LibraryDirectory();
    source(root, "sample.wav");
    const file = manifest(root, { "sample.wav": ["Existing"] });
    if (failure === "invalid") file.contents = "{invalid";
    else file.failRead = true;
    const previous = file.contents;
    const controller = new LibraryController(root);
    await controller.start();
    assert.equal(controller.getSnapshot().loading, false);
    assert.equal(controller.getSnapshot().manifest, undefined);
    assert.equal(controller.getSnapshot().tagsReadable, false);
    assert.notEqual(controller.getSnapshot().message, "");
    controller.editTags("sample.wav", ["Unsaved"]);
    await controller.saveTags("sample.wav");
    assert.equal(controller.getSnapshot().tagStatus["sample.wav"], undefined);
    assert.deepEqual(controller.tags("sample.wav"), []);
    assert.equal(file.contents, previous);
    assert.equal(file.writes, 0);
    controller.dispose();
  }
});

test("dispose cancels pending tag writes and suppresses their late notifications", async () => {
  const root = new LibraryDirectory();
  source(root, "sample.wav");
  const file = manifest(root, { "sample.wav": ["Old"] });
  const previous = file.contents;
  const pending = holdWrite(file);
  const controller = new LibraryController(root);
  await controller.start();
  controller.editTags("sample.wav", ["Unsaved"]);
  const save = controller.saveTags("sample.wav");
  await pending.reached;
  let notifications = 0;
  controller.subscribe(() => notifications++);
  controller.dispose();
  const snapshot = controller.getSnapshot();
  pending.release();
  await save;
  assert.equal(controller.getSnapshot(), snapshot);
  assert.equal(notifications, 0);
  assert.equal(file.contents, previous);
  assert.equal(file.aborts, 1);
  assert.equal(file.active, 0);
});

test("dispose ignores pending catalog, manifest and selected-file results", async () => {
  const root = new LibraryDirectory();
  const audio = source(root, "sample.wav");
  const file = manifest(root, { "sample.wav": ["Old"] });
  const pendingManifest = gate();
  const readManifest = file.getFile.bind(file);
  file.getFile = async () => {
    await pendingManifest.promise;
    return readManifest();
  };
  const controller = new LibraryController(root);
  const load = controller.start();
  controller.dispose();
  const snapshot = controller.getSnapshot();
  pendingManifest.release();
  await load;
  assert.equal(controller.getSnapshot(), snapshot);
  const selected = new LibraryController(root);
  await selected.start();
  const pendingAudio = gate();
  const readAudio = audio.getFile.bind(audio);
  audio.getFile = async () => {
    await pendingAudio.promise;
    return readAudio();
  };
  const selection = selected.select("sample.wav");
  selected.dispose();
  const selectedSnapshot = selected.getSnapshot();
  pendingAudio.release();
  await selection;
  assert.equal(selected.getSnapshot(), selectedSnapshot);
});

test("saving another record cannot replace a draft's original conflict baseline", async () => {
  const root = new LibraryDirectory();
  source(root, "one.wav");
  source(root, "two.wav");
  const file = manifest(root, { "one.wav": ["Old"], "two.wav": ["Other"] });
  const controller = new LibraryController(root);
  await controller.start();
  controller.editTags("one.wav", ["Stale draft"]);
  await saveSampleTags(root, "one.wav", ["External edit"], {
    expectedTags: ["Old"],
  });
  controller.editTags("two.wav", ["New other"]);
  await controller.saveTags("two.wav");
  assert.equal(controller.getSnapshot().tagStatus["two.wav"], "saved");
  assert.deepEqual(controller.tags("one.wav"), ["Stale draft"]);
  await controller.saveTags("one.wav");
  assert.equal(controller.getSnapshot().tagStatus["one.wav"], "error");
  assert.match(
    controller.getSnapshot().tagErrors["one.wav"],
    /another session/,
  );
  assert.deepEqual(controller.tags("one.wav"), ["Stale draft"]);
  assert.deepEqual(parseTagManifest(file.contents).samples["one.wav"].tags, [
    "External edit",
  ]);
  controller.dispose();
});

test("failed tag reload keeps the draft, previous manifest and unsaved error", async () => {
  const root = new LibraryDirectory();
  source(root, "sample.wav");
  const file = manifest(root, { "sample.wav": ["Old"] });
  const controller = new LibraryController(root);
  await controller.start();
  controller.editTags("sample.wav", ["Unsaved"]);
  const previous = controller.getSnapshot().manifest;
  file.failRead = true;
  await controller.reloadSavedTags("sample.wav");
  assert.equal(controller.getSnapshot().tagStatus["sample.wav"], "error");
  assert.notEqual(controller.getSnapshot().tagErrors["sample.wav"], "");
  assert.deepEqual(controller.tags("sample.wav"), ["Unsaved"]);
  assert.equal(controller.getSnapshot().manifest, previous);
  assert.equal(file.writes, 0);
  controller.dispose();
});

test("tag reload resolves only its draft and retains other draft conflict baselines", async () => {
  const root = new LibraryDirectory();
  source(root, "one.wav");
  source(root, "two.wav");
  const file = manifest(root, {
    "one.wav": ["Old one"],
    "two.wav": ["Old two"],
  });
  const controller = new LibraryController(root);
  await controller.start();
  controller.editTags("one.wav", ["Draft one"]);
  controller.editTags("two.wav", ["Draft two"]);
  await saveSampleTags(root, "one.wav", ["External one"], {
    expectedTags: ["Old one"],
  });
  await saveSampleTags(root, "two.wav", ["External two"], {
    expectedTags: ["Old two"],
  });
  await controller.reloadSavedTags("one.wav");
  assert.equal(controller.getSnapshot().tagStatus["one.wav"], "saved");
  assert.deepEqual(controller.tags("one.wav"), ["External one"]);
  assert.equal(controller.getSnapshot().tagStatus["two.wav"], "unsaved");
  assert.deepEqual(controller.tags("two.wav"), ["Draft two"]);
  controller.editTags("two.wav", ["Updated stale draft"]);
  await controller.saveTags("two.wav");
  assert.equal(controller.getSnapshot().tagStatus["two.wav"], "error");
  assert.deepEqual(parseTagManifest(file.contents).samples["two.wav"].tags, [
    "External two",
  ]);
  controller.editTags("one.wav", ["New one"]);
  await controller.saveTags("one.wav");
  assert.equal(controller.getSnapshot().tagStatus["one.wav"], "saved");
  assert.deepEqual(parseTagManifest(file.contents).samples["one.wav"].tags, [
    "New one",
  ]);
  controller.dispose();
});

test("dispose suppresses a late tag reload and retains its unsaved draft", async () => {
  const root = new LibraryDirectory();
  source(root, "sample.wav");
  const file = manifest(root, { "sample.wav": ["Old"] });
  const controller = new LibraryController(root);
  await controller.start();
  controller.editTags("sample.wav", ["Unsaved"]);
  const pending = gate();
  const read = file.getFile.bind(file);
  file.getFile = async () => {
    await pending.promise;
    return read();
  };
  const reload = controller.reloadSavedTags("sample.wav");
  controller.dispose();
  const snapshot = controller.getSnapshot();
  pending.release();
  await reload;
  assert.equal(controller.getSnapshot(), snapshot);
  assert.deepEqual(controller.tags("sample.wav"), ["Unsaved"]);
  assert.equal(file.writes, 0);
});

test("a delayed tag reload cannot replace another record's completed save", async () => {
  const root = new LibraryDirectory();
  source(root, "one.wav");
  source(root, "two.wav");
  const file = manifest(root, {
    "one.wav": ["Old one"],
    "two.wav": ["Old two"],
  });
  const controller = new LibraryController(root);
  await controller.start();
  controller.editTags("one.wav", ["Discarded draft"]);
  const pending = holdNextRead(file);
  const reload = controller.reloadSavedTags("one.wav");
  await pending.reached;
  controller.editTags("two.wav", ["New two"]);
  await controller.saveTags("two.wav");
  pending.release();
  await reload;
  assert.deepEqual(controller.tags("one.wav"), ["Old one"]);
  assert.equal(controller.getSnapshot().tagStatus["two.wav"], "saved");
  assert.deepEqual(controller.tags("two.wav"), ["New two"]);
  assert.deepEqual(
    controller.getSnapshot().manifest,
    parseTagManifest(file.contents),
  );
  controller.dispose();
});

test("a delayed reentry read cannot replace a tag save completed after its snapshot", async () => {
  const root = new LibraryDirectory();
  source(root, "sample.wav");
  const file = manifest(root, { "sample.wav": ["Old"] });
  const controller = new LibraryController(root);
  await controller.start();
  const pending = holdNextRead(file);
  const reentry = controller.start();
  await pending.reached;
  controller.editTags("sample.wav", ["New"]);
  await controller.saveTags("sample.wav");
  pending.release();
  await reentry;
  assert.equal(controller.getSnapshot().tagStatus["sample.wav"], "saved");
  assert.deepEqual(controller.tags("sample.wav"), ["New"]);
  assert.deepEqual(
    controller.getSnapshot().manifest,
    parseTagManifest(file.contents),
  );
  controller.dispose();
});

test("reentry refreshes metadata while retaining drafts and their conflict baselines", async () => {
  const root = new LibraryDirectory();
  const audio = source(root, "sample.wav");
  const file = manifest(root, { "sample.wav": ["Old"] });
  const controller = new LibraryController(root);
  await controller.start();
  controller.editTags("sample.wav", ["Unsaved"]);
  await saveSampleTags(root, "sample.wav", ["External edit"], {
    expectedTags: ["Old"],
  });
  source(root, "added.wav");
  await controller.start();
  assert.equal(controller.getSnapshot().catalog.rows.length, 2);
  assert.equal(audio.reads, 0);
  assert.deepEqual(controller.tags("sample.wav"), ["Unsaved"]);
  assert.equal(controller.getSnapshot().tagStatus["sample.wav"], "unsaved");
  await controller.saveTags("sample.wav");
  assert.equal(controller.getSnapshot().tagStatus["sample.wav"], "error");
  assert.match(
    controller.getSnapshot().tagErrors["sample.wav"],
    /another session/,
  );
  assert.deepEqual(parseTagManifest(file.contents).samples["sample.wav"].tags, [
    "External edit",
  ]);
  controller.dispose();
});

test("reentry does not retain removed saved tags or enable writes after a read failure", async () => {
  for (const result of ["missing", "unavailable"] as const) {
    const root = new LibraryDirectory();
    source(root, "sample.wav");
    source(root, "draft.wav");
    const file = manifest(root, { "sample.wav": ["Old"] });
    const controller = new LibraryController(root);
    await controller.start();
    controller.editTags("draft.wav", ["Unsaved"]);
    if (result === "missing") root.children.delete(TAGS_FILENAME);
    else file.failRead = true;
    await controller.start();
    assert.deepEqual(controller.tags("draft.wav"), ["Unsaved"]);
    assert.equal(controller.getSnapshot().tagStatus["draft.wav"], "unsaved");
    if (result === "missing") {
      assert.deepEqual(controller.tags("sample.wav"), []);
      assert.equal(controller.getSnapshot().manifest, undefined);
      assert.equal(controller.getSnapshot().tagsReadable, true);
    } else {
      assert.equal(controller.getSnapshot().tagsReadable, false);
      assert.notEqual(controller.getSnapshot().message, "");
    }
    controller.dispose();
  }
});

test("resume replaces revoked handles and retains a draft after an old pending save fails", async () => {
  const oldRoot = new LibraryDirectory();
  const oldSample = source(oldRoot, "sample.wav");
  const oldManifest = manifest(oldRoot, { "sample.wav": ["Old"] });
  const controller = new LibraryController(oldRoot);
  await controller.start();
  controller.editTags("sample.wav", ["Retained draft"]);
  const pending = holdWrite(oldManifest);
  const oldSave = controller.saveTags("sample.wav");
  await pending.reached;
  controller.suspend();
  const newRoot = regrant(oldRoot);
  const newSample = await newRoot.getFileHandle("sample.wav");
  controller.resume(newRoot);
  await controller.start();
  assert.deepEqual(controller.tags("sample.wav"), ["Retained draft"]);
  assert.equal(controller.getSnapshot().tagStatus["sample.wav"], "unsaved");
  assert.equal(controller.getSnapshot().catalog.rows[0].handle, newSample);
  assert.notEqual(newSample, oldSample);
  await assert.rejects(oldRoot.getFileHandle("sample.wav"), {
    name: "NotAllowedError",
  });
  await assert.rejects(oldSample.getFile(), { name: "NotAllowedError" });
  const resumed = controller.getSnapshot();
  pending.release();
  await oldSave;
  assert.equal(controller.getSnapshot(), resumed);
  assert.equal(oldManifest.aborts, 1);
  await controller.select("sample.wav");
  assert.equal(controller.getSnapshot().metadata?.encoding, "pcm16");
  assert.deepEqual(
    parseTagManifest(oldManifest.contents).samples["sample.wav"].tags,
    ["Old"],
  );
  await controller.saveTags("sample.wav");
  assert.equal(controller.getSnapshot().tagStatus["sample.wav"], "saved");
  assert.deepEqual(
    parseTagManifest(oldManifest.contents).samples["sample.wav"].tags,
    ["Retained draft"],
  );
  assert.equal(
    [...newRoot.children.keys()].some((name) =>
      name.startsWith(".ravefold-tags-lock-"),
    ),
    false,
  );
  controller.dispose();
});

test("a retained draft saves through the replacement folder grant", async () => {
  const oldRoot = new LibraryDirectory();
  const oldSample = source(oldRoot, "sample.wav");
  const oldManifest = manifest(oldRoot, { "sample.wav": ["Old"] });
  const controller = new LibraryController(oldRoot);
  await controller.start();
  controller.editTags("sample.wav", ["Retained draft"]);
  controller.suspend();
  const newRoot = regrant(oldRoot);
  controller.resume(newRoot);
  await controller.start();
  const newSample = await newRoot.getFileHandle("sample.wav");
  assert.equal(controller.getSnapshot().catalog.rows[0].handle, newSample);
  assert.notEqual(newSample, oldSample);
  assert.deepEqual(controller.tags("sample.wav"), ["Retained draft"]);
  await controller.select("sample.wav");
  assert.equal(controller.getSnapshot().metadata?.encoding, "pcm16");
  await controller.saveTags("sample.wav");
  assert.equal(controller.getSnapshot().tagStatus["sample.wav"], "saved");
  assert.deepEqual(
    parseTagManifest(oldManifest.contents).samples["sample.wav"].tags,
    ["Retained draft"],
  );
  assert.equal((await newRoot.getFileHandle(TAGS_FILENAME)).writes, 1);
  controller.dispose();
});

test("a suspended load cannot replace state from the new folder grant", async () => {
  const oldRoot = new LibraryDirectory();
  source(oldRoot, "sample.wav");
  const oldManifest = manifest(oldRoot, { "sample.wav": ["Old"] });
  const controller = new LibraryController(oldRoot);
  await controller.start();
  controller.editTags("sample.wav", ["Retained draft"]);
  const pending = holdNextRead(oldManifest);
  const oldLoad = controller.start();
  await pending.reached;
  controller.suspend();
  const newRoot = regrant(oldRoot);
  controller.resume(newRoot);
  await controller.start();
  const newSample = await newRoot.getFileHandle("sample.wav");
  const resumed = controller.getSnapshot();
  pending.release();
  await oldLoad;
  assert.equal(controller.getSnapshot(), resumed);
  assert.equal(controller.getSnapshot().catalog.rows[0].handle, newSample);
  assert.equal(controller.getSnapshot().loading, false);
  assert.equal(controller.getSnapshot().message, "");
  assert.deepEqual(controller.tags("sample.wav"), ["Retained draft"]);
  await controller.saveTags("sample.wav");
  assert.equal(controller.getSnapshot().tagStatus["sample.wav"], "saved");
  controller.dispose();
});

test("a suspended reload cannot discard a draft or baseline after a new folder grant", async () => {
  const oldRoot = new LibraryDirectory();
  source(oldRoot, "sample.wav");
  const oldManifest = manifest(oldRoot, { "sample.wav": ["Old"] });
  const controller = new LibraryController(oldRoot);
  await controller.start();
  controller.editTags("sample.wav", ["Retained draft"]);
  const pending = holdNextRead(oldManifest);
  const oldReload = controller.reloadSavedTags("sample.wav");
  await pending.reached;
  controller.suspend();
  const newRoot = regrant(oldRoot);
  await saveSampleTags(newRoot, "sample.wav", ["External edit"], {
    expectedTags: ["Old"],
  });
  controller.resume(newRoot);
  await controller.start();
  const resumed = controller.getSnapshot();
  pending.release();
  await oldReload;
  assert.equal(controller.getSnapshot(), resumed);
  assert.deepEqual(controller.tags("sample.wav"), ["Retained draft"]);
  assert.equal(controller.getSnapshot().tagStatus["sample.wav"], "unsaved");
  await controller.saveTags("sample.wav");
  assert.equal(controller.getSnapshot().tagStatus["sample.wav"], "error");
  assert.match(
    controller.getSnapshot().tagErrors["sample.wav"],
    /another session/,
  );
  assert.deepEqual(
    parseTagManifest(oldManifest.contents).samples["sample.wav"].tags,
    ["External edit"],
  );
  controller.dispose();
});
