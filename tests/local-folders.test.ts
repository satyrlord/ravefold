import assert from "node:assert/strict";
import test from "node:test";
import { createLocalFolderProvider } from "../src/storage/local-folders.ts";
import { configureFolderProvider } from "../src/storage/folder-provider.ts";
import { pickFolder, pickerAvailable } from "../src/storage/handles.ts";
import {
  loadFolderReferences,
  saveFolderReference,
} from "../src/storage/references.ts";
import {
  LOCAL_CHUNK_BYTES,
  LOCAL_FOLDER_HEADER,
  type LocalRequest,
} from "../shared/local-folder-protocol.ts";

function fixture(
  handler?: (request: LocalRequest) => unknown | Promise<unknown>,
) {
  const requests: LocalRequest[] = [];
  const bytes = new TextEncoder().encode("abcdefghijklmnopqrstuvwxyz");
  const fetcher: typeof fetch = async (_url, options) => {
    assert.equal(
      (options?.headers as Record<string, string>)[LOCAL_FOLDER_HEADER],
      "session-token",
    );
    assert.equal(options?.cache, "no-store");
    const request = JSON.parse(options?.body as string) as LocalRequest;
    requests.push(request);
    const custom = await handler?.(request);
    if (custom instanceof Response) return custom;
    let value: unknown = custom;
    if (custom === undefined)
      switch (request.op) {
        case "roots":
          value = {
            samples: { id: "samples-id", kind: "directory", name: "Samples" },
            settings: {
              id: "settings-id",
              kind: "directory",
              name: "Settings",
            },
          };
          break;
        case "child":
          value = { id: "file-id", kind: request.kind, name: request.name };
          break;
        case "file":
          value = {
            size: bytes.length,
            lastModified: 1234,
            version: "version-one",
          };
          break;
        case "read":
          value = Buffer.from(
            bytes.slice(request.offset, request.offset + request.length),
          ).toString("base64");
          break;
        case "writable":
          value = "writer-id";
          break;
        case "permission":
          value = "granted";
          break;
        default:
          value = null;
      }
    return Response.json({ ok: true, value });
  };
  return {
    provider: createLocalFolderProvider("session-token", fetcher),
    requests,
  };
}

test("local files read only requested ranges and preserve snapshot metadata", async () => {
  const { provider, requests } = fixture();
  const root = (await provider.roots()).samples!;
  const file = await (await root.getFileHandle("test.wav")).getFile();
  assert.equal(file.name, "test.wav");
  assert.equal(file.size, 26);
  assert.equal(file.type, "audio/wav");
  assert.equal(file.lastModified, 1234);
  assert.equal(requests.filter((request) => request.op === "read").length, 0);
  assert.equal(await file.slice(3, 7).text(), "defg");
  assert.deepEqual(requests.at(-1), {
    op: "read",
    handle: "file-id",
    version: "version-one",
    offset: 3,
    length: 4,
  });
  assert.equal(await file.slice(-4).slice(1, 3).text(), "xy");
  assert.equal((await file.bytes()).length, 26);
});

test("local provider restores configured roots and does not require IndexedDB", async () => {
  const { provider } = fixture();
  configureFolderProvider(provider);
  try {
    assert.equal(pickerAvailable(), true);
    const loaded = await loadFolderReferences();
    assert.equal(loaded.available, true);
    assert.equal(loaded.references.samples?.name, "Samples");
    const selected = await pickFolder("settings");
    assert.equal(selected.name, "Settings");
    assert.deepEqual(await saveFolderReference("settings", selected), {
      available: true,
    });
  } finally {
    configureFolderProvider(undefined);
  }
});

test("local writes use bounded chunks and close only after writes complete", async () => {
  const { provider, requests } = fixture();
  const root = (await provider.roots()).settings!;
  const writer = await (
    await root.getFileHandle("settings.json")
  ).createWritable();
  await writer.write(new Uint8Array(LOCAL_CHUNK_BYTES + 13));
  await writer.close();
  const chunks = requests.filter((request) => request.op === "write");
  assert.deepEqual(
    chunks.map((request) => Buffer.from(request.data, "base64").length),
    [LOCAL_CHUNK_BYTES, 13],
  );
  assert.equal(requests.at(-1)?.op, "close");
  await assert.rejects(writer.write("late"), { name: "InvalidStateError" });
});

test("an aborted write stops pending chunks and aborts the server writer", async () => {
  const controller = new AbortController();
  const { provider, requests } = fixture((request) => {
    if (request.op === "write") controller.abort();
  });
  const root = (await provider.roots()).settings!;
  const writer = await (
    await root.getFileHandle("settings.json")
  ).createWritable();
  await assert.rejects(
    writer.write(new Uint8Array(LOCAL_CHUNK_BYTES * 2), controller.signal),
    { name: "AbortError" },
  );
  await assert.rejects(writer.close(), { name: "InvalidStateError" });
  assert.equal(requests.filter((request) => request.op === "write").length, 1);
  assert.equal(requests.at(-1)?.op, "abort");
});

test("failed writes cannot commit and errors do not expose server details", async () => {
  const { provider, requests } = fixture((request) =>
    request.op === "write"
      ? Response.json({
          ok: false,
          error: { name: "NotAllowedError", message: "private server details" },
        })
      : undefined,
  );
  const root = (await provider.roots()).settings!;
  const writer = await (
    await root.getFileHandle("settings.json")
  ).createWritable();
  await assert.rejects(writer.write("data"), {
    name: "NotAllowedError",
    message: "Local folder access was denied.",
  });
  await assert.rejects(writer.close(), { name: "InvalidStateError" });
  assert.equal(requests.at(-1)?.op, "abort");
  assert.equal(
    requests.some((request) => request.op === "close"),
    false,
  );
});

test("snapshot changes reject reads without exposing server details", async () => {
  const { provider } = fixture((request) =>
    request.op === "read"
      ? Response.json({
          ok: false,
          error: { name: "InvalidStateError", message: "private path" },
        })
      : undefined,
  );
  const root = (await provider.roots()).samples!;
  const file = await (await root.getFileHandle("test.wav")).getFile();
  await assert.rejects(file.arrayBuffer(), {
    name: "InvalidStateError",
    message: "The local file operation is no longer available.",
  });
});

test("snapshot read errors retain the name used for retry decisions", async () => {
  const { provider } = fixture((request) =>
    request.op === "read"
      ? Response.json({
          ok: false,
          error: { name: "NotReadableError", message: "private path" },
        })
      : undefined,
  );
  const root = (await provider.roots()).samples!;
  const file = await (await root.getFileHandle("test.wav")).getFile();
  await assert.rejects(file.arrayBuffer(), {
    name: "NotReadableError",
    message: "The local file cannot be read. Try again.",
  });
});

test("stream cancellation aborts an in-flight local read", async () => {
  let readSignal: AbortSignal | null | undefined;
  let started: (() => void) | undefined;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetcher: typeof fetch = async (_url, options) => {
    const request = JSON.parse(options?.body as string) as LocalRequest;
    if (request.op === "roots")
      return Response.json({
        ok: true,
        value: {
          samples: { id: "s", kind: "directory", name: "Samples" },
          settings: { id: "t", kind: "directory", name: "Settings" },
        },
      });
    if (request.op === "child")
      return Response.json({
        ok: true,
        value: { id: "f", kind: "file", name: "test.wav" },
      });
    if (request.op === "file")
      return Response.json({
        ok: true,
        value: { size: 10, lastModified: 0, version: "v" },
      });
    readSignal = options?.signal;
    started!();
    return new Promise((_resolve, reject) => {
      readSignal!.addEventListener(
        "abort",
        () => reject(new DOMException("Canceled", "AbortError")),
        { once: true },
      );
    });
  };
  const provider = createLocalFolderProvider("token", fetcher);
  const root = (await provider.roots()).samples!;
  const file = await (await root.getFileHandle("test.wav")).getFile();
  const reader = file.stream().getReader();
  const pending = reader.read();
  await reading;
  await reader.cancel();
  assert.equal(readSignal?.aborted, true);
  assert.equal((await pending).done, true);
});
