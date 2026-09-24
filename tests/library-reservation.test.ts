import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withTagReservation } from "../src/library/tag-reservation.ts";
import {
  parseTagReservation,
  tagReservationName,
} from "../src/domain/tag-reservation.ts";
import {
  readTags,
  emptyTagManifest,
  TAGS_FILENAME,
} from "../src/library/tags.ts";
import { LibraryDirectory } from "./library-fixtures.ts";
import type {
  DirectoryHandle,
  FileHandle,
  WritableHandle,
} from "../src/storage/handles.ts";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const delay = (time = 10) =>
  new Promise<void>((resolve) => setTimeout(resolve, time));

test("independent participants serialize simultaneous entry from an empty registry", async () => {
  const root = new LibraryDirectory();
  let active = 0;
  let maximum = 0;
  let completed = 0;
  await Promise.all(
    Array.from({ length: 16 }, () =>
      withTagReservation(root, async () => {
        active++;
        maximum = Math.max(maximum, active);
        await delay(1);
        completed++;
        active--;
      }),
    ),
  );
  assert.equal(maximum, 1);
  assert.equal(completed, 16);
  assert.equal(root.children.size, 0);
});

test("a newcomer waits for an active participant and cancellation removes only its own register", async () => {
  const root = new LibraryDirectory();
  const entered = deferred();
  const release = deferred();
  const first = withTagReservation(root, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const firstName = [...root.children.keys()][0];
  const controller = new AbortController();
  let secondEntered = false;
  const second = withTagReservation(
    root,
    async () => {
      secondEntered = true;
    },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(second, { name: "AbortError" });
  await delay(30);
  assert.equal(secondEntered, false);
  controller.abort();
  await rejected;
  assert.deepEqual([...root.children.keys()], [firstName]);
  release.resolve();
  await first;
  assert.equal(root.children.size, 0);
});

test("empty, choosing and settled abandoned registers prevent entry without deletion", async () => {
  for (const state of ["empty", "choosing", "settled"] as const) {
    const root = new LibraryDirectory();
    const owner = randomUUID();
    const name = tagReservationName(owner);
    const contents =
      state === "empty"
        ? ""
        : JSON.stringify({
            schemaVersion: 1,
            owner,
            choosing: state === "choosing",
            ticket: state === "choosing" ? 0 : 1,
          });
    root.file(name, contents);
    let entered = false;
    await assert.rejects(
      withTagReservation(
        root,
        async () => {
          entered = true;
        },
        { timeoutMs: 40 },
      ),
      /blocked/u,
    );
    assert.equal(entered, false);
    assert.deepEqual([...root.children.keys()], [name]);
    assert.equal((await root.getFileHandle(name)).contents, contents);
  }
});

test("changed reservation data is preserved and fails the ownership check", async () => {
  const root = new LibraryDirectory();
  await assert.rejects(
    withTagReservation(root, async (assertOwned) => {
      const name = [...root.children.keys()][0]!;
      (await root.getFileHandle(name)).contents = "external change";
      await assertOwned();
    }),
    /blocked/u,
  );
  assert.equal(root.children.size, 1);
  assert.equal(
    (await root.getFileHandle([...root.children.keys()][0]!)).contents,
    "external change",
  );
});

test("same-folder permission recovery retries only this process's unfinished cleanup", async () => {
  const root = new LibraryDirectory();
  await assert.rejects(
    withTagReservation(root, async () => {
      root.state = "denied";
      throw new DOMException("Interrupted.", "AbortError");
    }),
    { name: "AbortError" },
  );
  assert.equal(root.children.size, 1);
  const other = new LibraryDirectory(root.name);
  await withTagReservation(other, async () => {});
  assert.equal(root.children.size, 1);
  root.state = "granted";
  await withTagReservation(root, async () => {});
  assert.equal(root.children.size, 0);
});

test("permission recovery keeps a replaced register even when its text is unchanged", async () => {
  const root = new LibraryDirectory();
  await assert.rejects(
    withTagReservation(root, async () => {
      root.state = "denied";
      throw new DOMException("Interrupted.", "AbortError");
    }),
    { name: "AbortError" },
  );
  const name = [...root.children.keys()][0]!;
  const original = await root.getFileHandle(name);
  const replacement = root.file(name, original.contents);
  root.state = "granted";
  await assert.rejects(
    withTagReservation(root, async () => {}, { timeoutMs: 40 }),
    /blocked/u,
  );
  assert.equal(await root.getFileHandle(name), replacement);
  assert.equal(root.children.size, 1);
});

test("reservation schema binds the writer identifier and rejects unsafe tickets", () => {
  const owner = randomUUID();
  const name = tagReservationName(owner);
  const row = { schemaVersion: 1, owner, choosing: false, ticket: 1 };
  assert.deepEqual(parseTagReservation(JSON.stringify(row), name), row);
  for (const change of [
    { owner: randomUUID() },
    { choosing: true },
    { ticket: -1 },
    { ticket: 0 },
    { ticket: Number.MAX_SAFE_INTEGER + 1 },
    { audio: [1] },
  ])
    assert.throws(() =>
      parseTagReservation(JSON.stringify({ ...row, ...change }), name),
    );
});

/** A browser-style adapter uses disk snapshots and atomic close, with no host lock. */
function browserDiskDirectory(folder: string): DirectoryHandle {
  const handles = new Map<string, FileHandle>();
  const root: DirectoryHandle = {
    kind: "directory",
    name: "samples",
    isSameEntry: async (other) => root === other,
    queryPermission: async () => "granted",
    requestPermission: async () => "granted",
    resolve: async (other) => (other === root ? [] : null),
    getDirectoryHandle: async () => {
      throw new Error("No nested test folders.");
    },
    removeEntry: async (name) => {
      await fs.unlink(path.join(folder, name));
      handles.delete(name);
    },
    getFileHandle: async (name, options) => {
      const target = path.join(folder, name);
      try {
        await fs.stat(target);
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
        if (!options?.create)
          throw new DOMException("Missing.", "NotFoundError");
        await (await fs.open(target, "a")).close();
      }
      const existing = handles.get(name);
      if (existing) return existing;
      const handle: FileHandle = {
        kind: "file",
        name,
        isSameEntry: async (other) => handle === other,
        getFile: async () => {
          // Windows reports EPERM for a file with a pending deletion.
          for (let attempt = 0; ; attempt++) {
            try {
              return new File([await fs.readFile(target)], name);
            } catch (error) {
              const code =
                error && typeof error === "object" && "code" in error
                  ? String(error.code)
                  : "";
              if (code === "ENOENT")
                throw new DOMException("Missing.", "NotFoundError");
              if (attempt >= 9 || !["EPERM", "EACCES", "EBUSY"].includes(code))
                throw error;
              await delay(20);
            }
          }
        },
        createWritable: async (): Promise<WritableHandle> => {
          let contents = "";
          return {
            write: async (value) => {
              if (typeof value !== "string") throw new Error("Metadata only.");
              contents = value;
            },
            close: async () => {
              const temporary = path.join(folder, `.test-${randomUUID()}`);
              await fs.writeFile(temporary, contents);
              for (let attempt = 0; ; attempt++) {
                try {
                  await fs.rename(temporary, target);
                  break;
                } catch (error) {
                  if (
                    attempt >= 9 ||
                    !error ||
                    typeof error !== "object" ||
                    !("code" in error) ||
                    !["EPERM", "EACCES", "EBUSY"].includes(String(error.code))
                  )
                    throw error;
                  await delay(20);
                }
              }
            },
            abort: async () => {},
          };
        },
      };
      handles.set(name, handle);
      return handle;
    },
    entries: async function* () {
      for (const name of await fs.readdir(folder)) {
        try {
          yield [name, await root.getFileHandle(name)];
        } catch (error) {
          if (!(error instanceof Error && error.name === "NotFoundError"))
            throw error;
        }
      }
    },
  };
  return root;
}

test("independent browser-style disk adapters use the same reservation protocol", async () => {
  const folder = await fs.mkdtemp(
    path.join(os.tmpdir(), "ravefold-tag-reservation-"),
  );
  try {
    const roots = Array.from({ length: 3 }, () => browserDiskDirectory(folder));
    let active = 0;
    let maximum = 0;
    await Promise.all(
      roots.map((root, index) =>
        withTagReservation(root, async (assertOwned) => {
          maximum = Math.max(maximum, ++active);
          const read = await readTags(root);
          const previous =
            read.status === "valid" ? read.value : emptyTagManifest();
          assert.ok(read.status === "valid" || read.status === "missing");
          const value = {
            ...previous,
            revision: previous.revision + 1,
            samples: {
              ...previous.samples,
              [`sample-${index}.wav`]: { tags: [`tag-${index}`] },
            },
          };
          await delay(5);
          const writer = await (
            await root.getFileHandle(TAGS_FILENAME, { create: true })
          ).createWritable({ mode: "exclusive" });
          await writer.write(JSON.stringify(value));
          await assertOwned();
          await writer.close();
          active--;
        }),
      ),
    );
    assert.equal(maximum, 1);
    const final = await readTags(roots[0]!);
    assert.equal(final.status, "valid");
    if (final.status !== "valid") throw new Error("Expected manifest.");
    assert.equal(final.value.revision, 3);
    assert.equal(Object.keys(final.value.samples).length, 3);
    assert.deepEqual(await fs.readdir(folder), [TAGS_FILENAME]);
  } finally {
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    assert.match(path.basename(folder), /^ravefold-tag-reservation-/u);
    await fs.rm(folder, { recursive: true, force: true });
  }
});
