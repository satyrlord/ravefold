import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_READ_BYTES,
  NATIVE_CHANNEL,
  NATIVE_VERSION,
  isNativeRequest,
  type NativeOperation,
  type HostOperation,
  type NativeRequest,
} from "../shared/native-protocol.ts";
import {
  NativeBridge,
  getNativeBridge,
  type NativeHostApi,
  type NativeMessageSource,
} from "../src/storage/native-bridge.ts";
import { validateWav } from "../src/domain/wav.ts";
import { pickerAvailable, pickFolder } from "../src/storage/handles.ts";
import {
  loadFolderReferences,
  saveFolderReference,
} from "../src/storage/references.ts";

type Operation = NativeOperation | HostOperation;

class HostFixture implements NativeHostApi, NativeMessageSource {
  requests: NativeRequest[] = [];
  listeners = new Set<(event: MessageEvent) => void>();
  handle: (request: Operation) => unknown | Promise<unknown>;
  constructor(handle: HostFixture["handle"]) {
    this.handle = handle;
  }
  addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent) => void,
  ) {
    this.listeners.delete(listener);
  }
  send(value: unknown) {
    for (const listener of this.listeners)
      listener(new MessageEvent("message", { data: value }));
  }
  postMessage(value: unknown) {
    assert.ok(isNativeRequest(value));
    this.requests.push(value);
    void Promise.resolve()
      .then(() => this.handle(value.request))
      .then(
        (result) =>
          this.send({
            channel: NATIVE_CHANNEL,
            version: NATIVE_VERSION,
            id: value.id,
            ok: true,
            result,
          }),
        (error: Error) =>
          this.send({
            channel: NATIVE_CHANNEL,
            version: NATIVE_VERSION,
            id: value.id,
            ok: false,
            error: { name: error.name, message: error.message },
          }),
      );
  }
}

function fileHost(contents: Uint8Array<ArrayBuffer>, fileName = "sample.wav") {
  let changed = false;
  const host = new HostFixture((request) => {
    if (request.op === "stat")
      return {
        name: fileName,
        size: contents.length,
        lastModified: 123,
        version: "snapshot-1",
      };
    if (request.op === "read") {
      if (changed)
        throw new DOMException(
          "The file changed. Read it again.",
          "NotReadableError",
        );
      assert.equal(request.version, "snapshot-1");
      assert.ok(request.length <= MAX_READ_BYTES);
      return {
        data: Buffer.from(
          contents.subarray(request.offset, request.offset + request.length),
        ).toString("base64"),
      };
    }
    throw new Error(`Unexpected request: ${request.op}`);
  });
  const bridge = new NativeBridge(host, host);
  const handle = bridge.handle({ id: "audio", name: fileName, kind: "file" });
  assert.equal(handle.kind, "file");
  if (handle.kind !== "file") throw new Error("Expected a file.");
  return {
    host,
    bridge,
    handle,
    change: () => {
      changed = true;
    },
  };
}

test("native WAV discovery reads PCM headers without copying audio data", async () => {
  const bytes = new Uint8Array(2 * 1024 * 1024 + 44);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 96000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode("data"), 36);
  view.setUint32(40, bytes.length - 44, true);
  const fixture = fileHost(bytes);
  try {
    const file = await fixture.handle.getFile();
    assert.equal(file.size, bytes.length);
    assert.equal(file.lastModified, 123);
    assert.equal(file.name, "sample.wav");
    assert.ok(file instanceof File);
    assert.equal((await validateWav(file)).valid, true);
    const reads = fixture.host.requests.flatMap(({ request }) =>
      request.op === "read" ? [request] : [],
    );
    assert.equal(
      reads.reduce((total, read) => total + read.length, 0),
      44,
    );
    assert.ok(reads.every((read) => read.offset + read.length <= 44));
  } finally {
    fixture.bridge.dispose();
  }
});

test("native files preserve slice bounds and keep reads within the chunk limit", async () => {
  const bytes = new Uint8Array(MAX_READ_BYTES * 2 + 17);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const fixture = fileHost(bytes);
  try {
    const file = await fixture.handle.getFile();
    assert.deepEqual(await file.bytes(), bytes);
    assert.deepEqual(
      new Uint8Array(await file.slice(-19, -2).arrayBuffer()),
      bytes.slice(-19, -2),
    );
    assert.equal(file.slice(10, 2).size, 0);
    assert.equal(file.slice(Number.NaN, 3).size, 3);
    assert.deepEqual(
      new Uint8Array(await file.slice(2, 20).slice(3, 7).arrayBuffer()),
      bytes.slice(5, 9),
    );
    assert.ok(
      fixture.host.requests.every(
        ({ request }) =>
          request.op !== "read" || request.length <= MAX_READ_BYTES,
      ),
    );
  } finally {
    fixture.bridge.dispose();
  }
});

test("native text preserves multibyte characters at a chunk boundary", async () => {
  const text = "x".repeat(MAX_READ_BYTES - 1) + "é音";
  const fixture = fileHost(new TextEncoder().encode(text), "metadata.json");
  try {
    assert.equal(await (await fixture.handle.getFile()).text(), text);
  } finally {
    fixture.bridge.dispose();
  }
});

test("native file snapshots reject later file changes", async () => {
  const fixture = fileHost(new Uint8Array([1, 2, 3]));
  try {
    const file = await fixture.handle.getFile();
    fixture.change();
    await assert.rejects(file.slice(0, 1).arrayBuffer(), {
      name: "NotReadableError",
    });
  } finally {
    fixture.bridge.dispose();
  }
});

test("native directory enumeration releases the cursor after an early return", async () => {
  const host = new HostFixture((request) => {
    if (request.op === "list")
      return {
        entries: [{ id: "audio", name: "sample.wav", kind: "file" }],
        cursor: "next-page",
      };
    if (request.op === "closeList") return null;
    throw new Error(`Unexpected request: ${request.op}`);
  });
  const bridge = new NativeBridge(host, host);
  try {
    const directory = bridge.handle({
      id: "root",
      name: "samples",
      kind: "directory",
    });
    assert.equal(directory.kind, "directory");
    if (directory.kind !== "directory") throw new Error("Expected a folder.");
    for await (const [name] of directory.entries()) {
      assert.equal(name, "sample.wav");
      break;
    }
    assert.deepEqual(
      host.requests.map(({ request }) => request.op),
      ["list", "closeList"],
    );
  } finally {
    bridge.dispose();
  }
});

test("native folder persistence transmits only opaque folder references", async () => {
  const host = new HostFixture((request) => {
    if (request.op === "pickFolder")
      return { id: "selected-root", name: "samples", kind: "directory" };
    if (request.op === "loadReferences")
      return {
        samples: { id: "restored-root", name: "samples", kind: "directory" },
      };
    if (request.op === "saveReference") return null;
    throw new Error(`Unexpected request: ${request.op}`);
  });
  const bridge = new NativeBridge(host, host);
  try {
    const handle = await bridge.pickFolder("samples");
    await bridge.saveReference("samples", handle);
    assert.ok((await bridge.loadReferences()).samples);
    assert.deepEqual(host.requests[1]!.request, {
      op: "saveReference",
      kind: "samples",
      handle: "selected-root",
    });
  } finally {
    bridge.dispose();
  }
});

test("native writes reject binary data and keep writer close or abort explicit", async () => {
  const host = new HostFixture((request) =>
    request.op === "openWriter" ? { writer: "metadata-writer" } : null,
  );
  const bridge = new NativeBridge(host, host);
  try {
    const handle = bridge.handle({
      id: "metadata",
      name: "ravefold-settings.json",
      kind: "file",
    });
    if (handle.kind !== "file") throw new Error("Expected a file.");
    const writer = await handle.createWritable({ mode: "exclusive" });
    await assert.rejects(writer.write(new Uint8Array([1])), /text metadata/);
    await writer.write("{}");
    await writer.abort();
    await assert.rejects(writer.close(), { name: "InvalidStateError" });
    assert.deepEqual(
      host.requests.map(({ request }) => request.op),
      ["openWriter", "write", "abortWriter"],
    );
  } finally {
    bridge.dispose();
  }
});

test("native transport rejects malformed responses, timeout, and disposal", async () => {
  const host = new HostFixture(() => new Promise(() => {}));
  const bridge = new NativeBridge(host, host, 10);
  const malformed = bridge.request({ op: "loadReferences" });
  const id = host.requests[0]!.id;
  host.send({
    channel: NATIVE_CHANNEL,
    version: NATIVE_VERSION,
    id,
    ok: "yes",
  });
  await assert.rejects(malformed, /invalid response/);
  await assert.rejects(bridge.request({ op: "loadReferences" }), {
    name: "TimeoutError",
  });
  const pending = bridge.request({ op: "loadReferences" });
  bridge.dispose();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(host.listeners.size, 0);
  await assert.rejects(bridge.request({ op: "loadReferences" }), {
    name: "AbortError",
  });
});

test("native revocation ends pending access and leaves transport usable for a new selection", async () => {
  let revoked = 0;
  const host = new HostFixture((request) =>
    request.op === "pickFolder"
      ? { id: "new-root", name: "samples", kind: "directory" }
      : new Promise(() => {}),
  );
  const bridge = new NativeBridge(host, host, 30000, () => {
    revoked++;
  });
  try {
    const pending = bridge.request({ op: "loadReferences" });
    host.send({
      channel: NATIVE_CHANNEL,
      version: NATIVE_VERSION,
      event: "revoked",
    });
    await assert.rejects(pending, { name: "NotAllowedError" });
    assert.equal(revoked, 1);
    assert.equal((await bridge.pickFolder("samples")).name, "samples");
  } finally {
    bridge.dispose();
  }
});

test("native reads reject invalid byte payloads", async () => {
  for (const data of ["not-base64!", "AA==", ""] as const) {
    const host = new HostFixture((request) =>
      request.op === "stat"
        ? { name: "sample.wav", size: 2, lastModified: 1, version: "one" }
        : { data },
    );
    const bridge = new NativeBridge(host, host);
    try {
      const handle = bridge.handle({
        id: "audio",
        name: "sample.wav",
        kind: "file",
      });
      if (handle.kind !== "file") throw new Error("Expected a file.");
      await assert.rejects(
        (await handle.getFile()).arrayBuffer(),
        /invalid response/,
      );
    } finally {
      bridge.dispose();
    }
  }
});

test("owned host selection and restoration use no browser persistence", async () => {
  const keys = [
    "document",
    "window",
    "acquireVsCodeApi",
    "indexedDB",
    "localStorage",
    "showDirectoryPicker",
  ] as const;
  const previous = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const events = new EventTarget();
  const requests: Operation[] = [];
  let acquisitions = 0;
  const documentStub = {
    documentElement: { dataset: {} as Record<string, string> },
  };
  const api = {
    postMessage: (value: unknown) => {
      assert.ok(isNativeRequest(value));
      requests.push(value.request);
      const folder = {
        id: "selected-root",
        name: "samples",
        kind: "directory",
      };
      const result =
        value.request.op === "loadReferences"
          ? { samples: folder }
          : value.request.op === "pickFolder"
            ? folder
            : null;
      queueMicrotask(() =>
        events.dispatchEvent(
          new MessageEvent("message", {
            data: {
              channel: NATIVE_CHANNEL,
              version: NATIVE_VERSION,
              id: value.id,
              ok: true,
              result,
            },
          }),
        ),
      );
    },
  };
  try {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: documentStub,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: events,
    });
    Object.defineProperty(globalThis, "acquireVsCodeApi", {
      configurable: true,
      value: () => {
        acquisitions++;
        return api;
      },
    });
    Object.defineProperty(globalThis, "showDirectoryPicker", {
      configurable: true,
      value: () => {
        throw new Error("The native host must own the picker.");
      },
    });
    for (const key of ["indexedDB", "localStorage"] as const) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        get: () => {
          throw new Error("Browser storage must not be accessed.");
        },
      });
    }
    assert.equal(getNativeBridge(), undefined);
    assert.equal(acquisitions, 0);
    documentStub.documentElement.dataset.ravefoldNative = "1";
    assert.equal(pickerAvailable(), true);
    const handle = await pickFolder("samples");
    assert.deepEqual(await saveFolderReference("samples", handle), {
      available: true,
    });
    const restored = await loadFolderReferences();
    assert.equal(restored.available, true);
    assert.equal(restored.references.samples?.name, "samples");
    assert.equal(acquisitions, 1);
    assert.deepEqual(
      requests.map((request) => request.op),
      ["pickFolder", "saveReference", "loadReferences"],
    );
    events.dispatchEvent(new Event("pagehide"));
  } finally {
    getNativeBridge()?.dispose();
    for (const key of keys) {
      const old = previous.get(key);
      if (old) Object.defineProperty(globalThis, key, old);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
