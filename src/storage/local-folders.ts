import {
  LOCAL_CHUNK_BYTES,
  LOCAL_FOLDER_ENDPOINT,
  LOCAL_FOLDER_HEADER,
  type LocalFileInfo,
  type LocalHandle,
  type LocalRequest,
  type LocalResponse,
} from "../../shared/local-folder-protocol.ts";
import type {
  AccessState,
  DirectoryHandle,
  FileHandle,
  FolderKind,
  HandleBase,
  WritableHandle,
} from "./handles.ts";
import type { FolderProvider } from "./folder-provider.ts";

type Request = <T>(request: LocalRequest, signal?: AbortSignal) => Promise<T>;
const messages: Record<string, string> = {
  NotFoundError: "The local file or folder is unavailable.",
  NotAllowedError: "Local folder access was denied.",
  NotReadableError: "The local file cannot be read. Try again.",
  InvalidStateError: "The local file operation is no longer available.",
  NoModificationAllowedError: "The local file cannot be changed.",
  TypeMismatchError: "The local entry has a different type.",
  AbortError: "The local file operation was canceled.",
};

function requestClient(token: string, fetcher: typeof fetch): Request {
  return async <T>(request: LocalRequest, signal?: AbortSignal): Promise<T> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetcher(LOCAL_FOLDER_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [LOCAL_FOLDER_HEADER]: token,
        },
        body: JSON.stringify(request),
        signal: signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw new Error("Local folder access failed.");
      const result = (await response.json()) as LocalResponse;
      if (!result.ok) {
        const name = Object.hasOwn(messages, result.error.name)
          ? result.error.name
          : "UnknownError";
        throw new DOMException(
          messages[name] ?? "The local file operation failed.",
          name,
        );
      }
      return result.value as T;
    } catch (error) {
      if (signal?.aborted)
        throw new DOMException(messages.AbortError, "AbortError");
      if (error instanceof DOMException && Object.hasOwn(messages, error.name))
        throw error;
      throw new Error(
        "Local folder access failed. Check the development server.",
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function encode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function boundary(value: number, size: number): number {
  const integer = Number.isNaN(value) ? 0 : Math.trunc(value);
  return integer < 0 ? Math.max(size + integer, 0) : Math.min(integer, size);
}

// Lazy files support these methods only. Native Blob consumers, such as
// FileReader and object URLs, cannot read their empty internal data.
class RemoteBlob extends Blob {
  private request: Request;
  private handle: string;
  private version: string;
  private offset: number;
  private length: number;

  constructor(
    request: Request,
    handle: string,
    version: string,
    offset: number,
    length: number,
    type = "",
  ) {
    super([], { type });
    this.request = request;
    this.handle = handle;
    this.version = version;
    this.offset = offset;
    this.length = length;
  }

  override get size(): number {
    return this.length;
  }

  override slice(start = 0, end = this.size, contentType = ""): Blob {
    const first = boundary(start, this.size);
    const last = boundary(end, this.size);
    return new RemoteBlob(
      this.request,
      this.handle,
      this.version,
      this.offset + first,
      Math.max(last - first, 0),
      contentType,
    );
  }

  override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    let position = 0;
    const controller = new AbortController();
    return new ReadableStream({
      pull: async (stream) => {
        if (position === this.size) {
          stream.close();
          return;
        }
        try {
          const length = Math.min(LOCAL_CHUNK_BYTES, this.size - position);
          const bytes = decode(
            await this.request<string>(
              {
                op: "read",
                handle: this.handle,
                version: this.version,
                offset: this.offset + position,
                length,
              },
              controller.signal,
            ),
          );
          if (bytes.byteLength !== length)
            throw new Error("The local file read was incomplete.");
          position += length;
          stream.enqueue(bytes);
        } catch (error) {
          if (!controller.signal.aborted) stream.error(error);
        }
      },
      cancel: () => controller.abort(),
    });
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = new Uint8Array(this.size);
    const reader = this.stream().getReader();
    let offset = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        bytes.set(result.value, offset);
        offset += result.value.length;
      }
    } finally {
      reader.releaseLock();
    }
    return bytes.buffer;
  }

  override async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await this.arrayBuffer());
  }
  override async text(): Promise<string> {
    return new TextDecoder().decode(await this.arrayBuffer());
  }
}

class RemoteFile extends File {
  private contents: RemoteBlob;
  constructor(request: Request, handle: LocalHandle, info: LocalFileInfo) {
    const type = handle.name.toLowerCase().endsWith(".wav") ? "audio/wav" : "";
    super([], handle.name, { lastModified: info.lastModified, type });
    this.contents = new RemoteBlob(
      request,
      handle.id,
      info.version,
      0,
      info.size,
      type,
    );
  }
  override get size(): number {
    return this.contents.size;
  }
  override slice(start?: number, end?: number, type?: string): Blob {
    return this.contents.slice(start, end, type);
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

class LocalWritable implements WritableHandle {
  private request: Request;
  private writer: string;
  private state: "open" | "busy" | "closed" = "open";
  private cancellation = new AbortController();
  constructor(request: Request, writer: string) {
    this.request = request;
    this.writer = writer;
  }

  async write(
    data: string | Blob | ArrayBuffer | ArrayBufferView,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.state !== "open")
      throw new DOMException(messages.InvalidStateError, "InvalidStateError");
    this.state = "busy";
    const combined = signal
      ? AbortSignal.any([signal, this.cancellation.signal])
      : this.cancellation.signal;
    try {
      combined.throwIfAborted();
      const blob =
        data instanceof Blob
          ? data
          : new Blob([
              ArrayBuffer.isView(data)
                ? new Uint8Array(
                    data.buffer,
                    data.byteOffset,
                    data.byteLength,
                  ).slice()
                : data,
            ]);
      for (let offset = 0; offset < blob.size; offset += LOCAL_CHUNK_BYTES) {
        combined.throwIfAborted();
        const chunk = new Uint8Array(
          await blob.slice(offset, offset + LOCAL_CHUNK_BYTES).arrayBuffer(),
        );
        combined.throwIfAborted();
        await this.request(
          { op: "write", writer: this.writer, data: encode(chunk) },
          combined,
        );
      }
      combined.throwIfAborted();
      this.state = "open";
    } catch (error) {
      await this.abort().catch(() => {});
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.state !== "open")
      throw new DOMException(messages.InvalidStateError, "InvalidStateError");
    this.state = "busy";
    try {
      await this.request({ op: "close", writer: this.writer });
      this.state = "closed";
    } catch (error) {
      await this.abort().catch(() => {});
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    this.cancellation.abort();
    await this.request({ op: "abort", writer: this.writer });
  }
}

export function createLocalFolderProvider(
  token: string,
  fetcher: typeof fetch = fetch,
): FolderProvider {
  if (!token) throw new Error("Local folder access is unavailable.");
  const request = requestClient(token, fetcher);
  const handles = new WeakMap<HandleBase, string>();

  function wrap(handle: LocalHandle): DirectoryHandle | FileHandle {
    const common: HandleBase = {
      name: handle.name,
      kind: handle.kind,
      isSameEntry: async (other) => {
        const id = handles.get(other);
        return id === undefined
          ? false
          : request<boolean>({ op: "same", handle: handle.id, other: id });
      },
    };
    const result: DirectoryHandle | FileHandle =
      handle.kind === "file"
        ? {
            ...common,
            kind: "file",
            getFile: async () =>
              new RemoteFile(
                request,
                handle,
                await request<LocalFileInfo>({ op: "file", handle: handle.id }),
              ),
            createWritable: async (options) => {
              if (options?.keepExistingData)
                throw new DOMException(
                  "Existing file data cannot be retained.",
                  "NotSupportedError",
                );
              return new LocalWritable(
                request,
                await request<string>({ op: "writable", handle: handle.id }),
              );
            },
          }
        : {
            ...common,
            kind: "directory",
            queryPermission: () =>
              request<AccessState>({ op: "permission", handle: handle.id }),
            requestPermission: () =>
              request<AccessState>({ op: "permission", handle: handle.id }),
            getFileHandle: async (name, options) =>
              wrap(
                await request<LocalHandle>({
                  op: "child",
                  handle: handle.id,
                  name,
                  kind: "file",
                  ...options,
                }),
              ) as FileHandle,
            getDirectoryHandle: async (name, options) =>
              wrap(
                await request<LocalHandle>({
                  op: "child",
                  handle: handle.id,
                  name,
                  kind: "directory",
                  ...options,
                }),
              ) as DirectoryHandle,
            async *entries() {
              for (const child of await request<LocalHandle[]>({
                op: "entries",
                handle: handle.id,
              }))
                yield [child.name, wrap(child)];
            },
            resolve: async (other) => {
              const id = handles.get(other);
              return id === undefined
                ? null
                : request<string[] | null>({
                    op: "resolve",
                    handle: handle.id,
                    other: id,
                  });
            },
            removeEntry: async (name) => {
              await request({ op: "remove", handle: handle.id, name });
            },
          };
    handles.set(result, handle.id);
    return result;
  }

  async function roots(): Promise<Record<FolderKind, DirectoryHandle>> {
    const value = await request<Record<FolderKind, LocalHandle>>({
      op: "roots",
    });
    return {
      samples: wrap(value.samples) as DirectoryHandle,
      settings: wrap(value.settings) as DirectoryHandle,
    };
  }
  return { roots, pick: async (kind) => (await roots())[kind] };
}
