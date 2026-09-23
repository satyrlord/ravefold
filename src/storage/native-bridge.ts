import type {
  AccessState,
  DirectoryHandle,
  FileHandle,
  FolderKind,
  HandleBase,
  WritableHandle,
} from "./handles.ts";
import {
  NATIVE_CHANNEL as channel,
  NATIVE_VERSION as version,
  MAX_READ_BYTES as chunkBytes,
  MAX_WRITE_BYTES as writeChunkBytes,
  type NativeHandle as HandleDescriptor,
  type NativeFileInfo as FileSnapshot,
  type NativeOperation,
  type HostOperation,
} from "../../shared/native-protocol.ts";

export interface NativeHostApi {
  postMessage(message: unknown): void;
}

export interface NativeMessageSource {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function protocolError(): Error {
  return new Error("The folder host returned an invalid response.");
}

function emptyResult(value: unknown): void {
  if (value !== null && value !== undefined) throw protocolError();
}

function encodeBytes(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 16_384)));
  }
  return btoa(parts.join(""));
}

async function writeAudio(
  bridge: NativeBridge,
  writer: string,
  data: Blob | ArrayBuffer | ArrayBufferView,
  signal?: AbortSignal,
): Promise<void> {
  if (data instanceof Blob) {
    for (let offset = 0; offset < data.size; offset += writeChunkBytes) {
      signal?.throwIfAborted();
      const bytes = new Uint8Array(
        await data.slice(offset, offset + writeChunkBytes).arrayBuffer(),
      );
      signal?.throwIfAborted();
      emptyResult(
        await bridge.request({
          op: "writeBytes",
          writer,
          data: encodeBytes(bytes),
        }),
      );
    }
    signal?.throwIfAborted();
    return;
  }
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = 0; offset < bytes.length; offset += writeChunkBytes) {
    signal?.throwIfAborted();
    emptyResult(
      await bridge.request({
        op: "writeBytes",
        writer,
        data: encodeBytes(bytes.subarray(offset, offset + writeChunkBytes)),
      }),
    );
  }
  signal?.throwIfAborted();
}

function audioWritable(bridge: NativeBridge, writer: string): WritableHandle {
  let closed = false;
  let failed: unknown;
  let pending: Promise<void> = Promise.resolve();
  return {
    write(data, signal) {
      if (closed)
        return Promise.reject(
          new DOMException("The audio writer is closed.", "InvalidStateError"),
        );
      if (
        typeof data === "string" ||
        (!(data instanceof Blob) &&
          !(data instanceof ArrayBuffer) &&
          !ArrayBuffer.isView(data))
      )
        return Promise.reject(
          new TypeError("A WAV write requires binary data."),
        );
      const next = pending.then(async () => {
        if (failed) throw failed;
        await writeAudio(bridge, writer, data, signal);
      });
      pending = next.catch((error: unknown) => {
        failed = error;
      });
      return next;
    },
    async close() {
      if (closed)
        throw new DOMException(
          "The audio writer is closed.",
          "InvalidStateError",
        );
      closed = true;
      await pending;
      if (failed) {
        await bridge
          .request({ op: "abortWriter", writer })
          .catch(() => undefined);
        throw failed;
      }
      emptyResult(await bridge.request({ op: "closeWriter", writer }));
    },
    async abort() {
      if (closed) return;
      closed = true;
      await pending;
      emptyResult(await bridge.request({ op: "abortWriter", writer }));
    },
  };
}

function descriptor(value: unknown): HandleDescriptor {
  if (
    !record(value) ||
    !nonemptyString(value.id) ||
    !nonemptyString(value.name) ||
    (value.kind !== "file" && value.kind !== "directory")
  )
    throw protocolError();
  return { id: value.id, name: value.name, kind: value.kind };
}

function snapshot(value: unknown): FileSnapshot {
  if (
    !record(value) ||
    !nonemptyString(value.name) ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    typeof value.lastModified !== "number" ||
    !Number.isFinite(value.lastModified) ||
    !nonemptyString(value.version)
  )
    throw protocolError();
  return {
    name: value.name,
    size: value.size as number,
    lastModified: value.lastModified,
    version: value.version,
  };
}

/** The extension owns folder grants. The browser receives opaque handles only. */
export class NativeBridge {
  private api: NativeHostApi;
  private source: NativeMessageSource;
  private pending = new Map<string, PendingRequest>();
  private timeoutMs: number;
  private disposed = false;
  private sequence = 0;
  private onRevoked: () => void;
  private readonly session = crypto.randomUUID();
  private readonly receive = (event: MessageEvent) => {
    const message: unknown = event.data;
    if (
      !record(message) ||
      message.channel !== channel ||
      message.version !== version
    )
      return;
    if (message.event === "revoked") {
      this.rejectPending(
        new DOMException(
          "Folder access was removed. Select both folders again.",
          "NotAllowedError",
        ),
      );
      this.onRevoked();
      return;
    }
    if (typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok === true && Object.hasOwn(message, "result")) {
      pending.resolve(message.result);
    } else if (
      message.ok === false &&
      record(message.error) &&
      nonemptyString(message.error.name) &&
      typeof message.error.message === "string"
    ) {
      pending.reject(
        new DOMException(message.error.message, message.error.name),
      );
    } else {
      pending.reject(protocolError());
    }
  };

  constructor(
    api: NativeHostApi,
    source: NativeMessageSource,
    timeoutMs = 30000,
    onRevoked = () => {},
  ) {
    this.api = api;
    this.source = source;
    this.timeoutMs = timeoutMs;
    this.onRevoked = onRevoked;
    source.addEventListener("message", this.receive);
  }

  request(request: NativeOperation | HostOperation): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(
        new DOMException("The folder host is closed.", "AbortError"),
      );
    }
    const id = `${this.session}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(
            new DOMException(
              "The folder host did not respond. Try again.",
              "TimeoutError",
            ),
          );
        },
        request.op === "pickFolder"
          ? Math.max(this.timeoutMs, 300000)
          : this.timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.api.postMessage({ channel, version, id, request });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.source.removeEventListener("message", this.receive);
    this.rejectPending(
      new DOMException("The folder host is closed.", "AbortError"),
    );
  }

  private rejectPending(error: DOMException): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  handle(value: unknown): NativeDirectoryHandle | NativeFileHandle {
    const valueDescriptor = descriptor(value);
    return valueDescriptor.kind === "directory"
      ? new NativeDirectoryHandle(this, valueDescriptor)
      : new NativeFileHandle(this, valueDescriptor);
  }

  async pickFolder(kind: FolderKind): Promise<DirectoryHandle> {
    const handle = this.handle(await this.request({ op: "pickFolder", kind }));
    if (handle.kind !== "directory") throw protocolError();
    return handle;
  }

  async loadReferences(): Promise<
    Partial<Record<FolderKind, DirectoryHandle>>
  > {
    const value = await this.request({ op: "loadReferences" });
    if (!record(value)) throw protocolError();
    const references: Partial<Record<FolderKind, DirectoryHandle>> = {};
    for (const kind of ["samples", "settings"] as const) {
      if (value[kind] === undefined) continue;
      const handle = this.handle(value[kind]);
      if (handle.kind !== "directory") throw protocolError();
      references[kind] = handle;
    }
    return references;
  }

  async saveReference(
    kind: FolderKind,
    handle: DirectoryHandle,
  ): Promise<void> {
    if (!(handle instanceof NativeDirectoryHandle) || handle.bridge !== this) {
      throw new Error("The folder reference belongs to a different host.");
    }
    emptyResult(
      await this.request({ op: "saveReference", kind, handle: handle.id }),
    );
  }

  async read(
    handle: string,
    file: FileSnapshot,
    offset: number,
    length: number,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const value = await this.request({
      op: "read",
      handle,
      version: file.version,
      offset,
      length,
    });
    if (
      !record(value) ||
      typeof value.data !== "string" ||
      value.data.length > Math.ceil(chunkBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value.data,
      )
    )
      throw protocolError();
    const decoded = atob(value.data);
    if (decoded.length !== length) throw protocolError();
    return Uint8Array.from(decoded, (byte) => byte.charCodeAt(0));
  }
}

class NativeHandle {
  readonly name: string;
  readonly id: string;
  readonly bridge: NativeBridge;

  constructor(bridge: NativeBridge, handle: HandleDescriptor) {
    this.bridge = bridge;
    this.id = handle.id;
    this.name = handle.name;
  }

  async isSameEntry(other: HandleBase): Promise<boolean> {
    if (!(other instanceof NativeHandle) || other.bridge !== this.bridge)
      return false;
    const result = await this.bridge.request({
      op: "same",
      handle: this.id,
      other: other.id,
    });
    if (typeof result !== "boolean") throw protocolError();
    return result;
  }
}

class NativeDirectoryHandle extends NativeHandle implements DirectoryHandle {
  readonly kind = "directory";

  async queryPermission(_options: { mode: "readwrite" }): Promise<AccessState> {
    const state = await this.bridge.request({
      op: "permission",
      handle: this.id,
    });
    if (state !== "granted" && state !== "prompt" && state !== "denied")
      throw protocolError();
    return state;
  }

  requestPermission(options: { mode: "readwrite" }): Promise<AccessState> {
    return this.queryPermission(options);
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileHandle> {
    const handle = this.bridge.handle(
      await this.bridge.request({
        op: "getFile",
        handle: this.id,
        name,
        create: options?.create ?? false,
      }),
    );
    if (handle.kind !== "file") throw protocolError();
    return handle;
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<DirectoryHandle> {
    const handle = this.bridge.handle(
      await this.bridge.request({
        op: "getDirectory",
        handle: this.id,
        name,
        create: options?.create ?? false,
      }),
    );
    if (handle.kind !== "directory") throw protocolError();
    return handle;
  }

  async *entries(): AsyncIterableIterator<
    [string, DirectoryHandle | FileHandle]
  > {
    let cursor: string | undefined;
    try {
      do {
        const value = await this.bridge.request({
          op: "list",
          handle: this.id,
          ...(cursor ? { cursor } : {}),
          limit: 128,
        });
        if (
          !record(value) ||
          !Array.isArray(value.entries) ||
          value.entries.length > 256 ||
          (value.cursor !== undefined && !nonemptyString(value.cursor))
        )
          throw protocolError();
        cursor = value.cursor as string | undefined;
        for (const entry of value.entries) {
          const handle = this.bridge.handle(entry);
          yield [handle.name, handle];
        }
      } while (cursor);
    } finally {
      if (cursor)
        await this.bridge
          .request({ op: "closeList", cursor })
          .catch(() => undefined);
    }
  }

  async resolve(other: HandleBase): Promise<string[] | null> {
    if (!(other instanceof NativeHandle) || other.bridge !== this.bridge)
      return null;
    const value = await this.bridge.request({
      op: "resolve",
      handle: this.id,
      other: other.id,
    });
    if (value === null) return null;
    if (
      !Array.isArray(value) ||
      !value.every(
        (part) =>
          nonemptyString(part) &&
          part !== "." &&
          part !== ".." &&
          !/[\\/]/.test(part),
      )
    )
      throw protocolError();
    return value as string[];
  }

  async removeEntry(name: string): Promise<void> {
    emptyResult(
      await this.bridge.request({ op: "remove", handle: this.id, name }),
    );
  }
}

class NativeFileHandle extends NativeHandle implements FileHandle {
  readonly kind = "file";

  async getFile(): Promise<File> {
    return new NativeFile(
      this.bridge,
      this.id,
      snapshot(await this.bridge.request({ op: "stat", handle: this.id })),
    );
  }

  async createWritable(options?: {
    keepExistingData?: boolean;
    mode?: "exclusive" | "siloed";
  }): Promise<WritableHandle> {
    if (options?.keepExistingData)
      throw new Error("This host supports complete file writes only.");
    const value = await this.bridge.request({
      op: "openWriter",
      handle: this.id,
    });
    if (
      !record(value) ||
      !nonemptyString(value.writer) ||
      (value.kind !== undefined &&
        value.kind !== "audio" &&
        value.kind !== "metadata")
    )
      throw protocolError();
    const writer = value.writer;
    if (value.kind === "audio") return audioWritable(this.bridge, writer);
    let closed = false;
    return {
      write: async (data) => {
        if (closed)
          throw new DOMException(
            "The metadata writer is closed.",
            "InvalidStateError",
          );
        if (typeof data !== "string")
          throw new Error("This host supports text metadata writes only.");
        emptyResult(await this.bridge.request({ op: "write", writer, data }));
      },
      close: async () => {
        if (closed)
          throw new DOMException(
            "The metadata writer is closed.",
            "InvalidStateError",
          );
        emptyResult(await this.bridge.request({ op: "closeWriter", writer }));
        closed = true;
      },
      abort: async () => {
        if (closed) return;
        emptyResult(await this.bridge.request({ op: "abortWriter", writer }));
        closed = true;
      },
    };
  }
}

function sliceOffset(
  value: number | undefined,
  size: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const integer = Number.isNaN(value) ? 0 : Math.trunc(value);
  return integer < 0 ? Math.max(size + integer, 0) : Math.min(integer, size);
}

class NativeBlob extends Blob {
  private bridge: NativeBridge;
  private handle: string;
  private file: FileSnapshot;
  private offset: number;
  private length: number;

  constructor(
    bridge: NativeBridge,
    handle: string,
    file: FileSnapshot,
    offset = 0,
    length = file.size,
    type = "",
  ) {
    super([], { type });
    this.bridge = bridge;
    this.handle = handle;
    this.file = file;
    this.offset = offset;
    this.length = length;
  }

  override get size(): number {
    return this.length;
  }

  override slice(start?: number, end?: number, contentType = ""): Blob {
    const first = sliceOffset(start, this.length, 0);
    const last = sliceOffset(end, this.length, this.length);
    return new NativeBlob(
      this.bridge,
      this.handle,
      this.file,
      this.offset + first,
      Math.max(last - first, 0),
      contentType,
    );
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.bytes();
    return bytes.buffer;
  }

  override async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(this.length);
    for (let offset = 0; offset < this.length; offset += chunkBytes) {
      bytes.set(
        await this.bridge.read(
          this.handle,
          this.file,
          this.offset + offset,
          Math.min(chunkBytes, this.length - offset),
        ),
        offset,
      );
    }
    return bytes;
  }

  override async text(): Promise<string> {
    const reader = this.stream().getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        parts.push(decoder.decode(value, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join("");
    } finally {
      reader.releaseLock();
    }
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    let offset = 0;
    let cancelled = false;
    return new ReadableStream({
      pull: async (controller) => {
        if (offset >= this.length) {
          controller.close();
          return;
        }
        const length = Math.min(chunkBytes, this.length - offset);
        const bytes = await this.bridge.read(
          this.handle,
          this.file,
          this.offset + offset,
          length,
        );
        if (cancelled) return;
        offset += length;
        controller.enqueue(bytes);
      },
      cancel: () => {
        cancelled = true;
      },
    });
  }
}

class NativeFile extends File {
  private contents: NativeBlob;
  constructor(bridge: NativeBridge, handle: string, file: FileSnapshot) {
    super([], file.name, { lastModified: file.lastModified });
    this.contents = new NativeBlob(bridge, handle, file);
  }
  override get size(): number {
    return this.contents.size;
  }
  override slice(start?: number, end?: number, contentType?: string): Blob {
    return this.contents.slice(start, end, contentType);
  }
  override arrayBuffer(): Promise<ArrayBuffer> {
    return this.contents.arrayBuffer();
  }
  override bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return this.contents.bytes();
  }
  override text(): Promise<string> {
    return this.contents.text();
  }
  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return this.contents.stream();
  }
}

let bridge: NativeBridge | undefined;
let acquisitionAttempted = false;

export function getNativeBridge(): NativeBridge | undefined {
  if (bridge || acquisitionAttempted) return bridge;
  if (
    typeof document === "undefined" ||
    document.documentElement.dataset.ravefoldNative !== "1"
  )
    return undefined;
  acquisitionAttempted = true;
  const host = globalThis as typeof globalThis & {
    acquireVsCodeApi?: () => NativeHostApi;
  };
  if (typeof host.acquireVsCodeApi !== "function") return undefined;
  try {
    bridge = new NativeBridge(host.acquireVsCodeApi(), window, 30000, () => {
      window.dispatchEvent(new CustomEvent("ravefold:native-revoked"));
    });
    window.addEventListener("pagehide", () => bridge?.dispose(), {
      once: true,
    });
    return bridge;
  } catch {
    return undefined;
  }
}

export function isNativeDirectoryHandle(handle: DirectoryHandle): boolean {
  return handle instanceof NativeDirectoryHandle;
}

export function nativeBridgeAvailable(): boolean {
  return getNativeBridge() !== undefined;
}
