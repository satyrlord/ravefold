import { createHash } from "node:crypto";
import { PREPARATION_MANIFEST_FILENAME } from "../src/domain/preparation.ts";
import {
  prepareAudio,
  type PrepareOutcome,
} from "../src/audio/prepare-core.ts";
import type {
  PreparationRequest,
  PreparationRun,
  PreparationRunner,
} from "../src/audio/preparer.ts";
import type {
  AccessState,
  DirectoryHandle,
  FileHandle,
  HandleBase,
  WritableHandle,
} from "../src/storage/handles.ts";

export interface WriteRecord {
  path: string;
  kind: "audio" | "text";
}

/** Shared state for one fixture tree. */
export class FixtureDisk {
  writes: WriteRecord[] = [];
  removals: string[] = [];
  state: AccessState = "granted";
  /** Fail audio writes with this error name, for example QuotaExceededError. */
  failAudio: string | null = null;
  failPreparationManifest: string | null = null;
  holdAudio: Promise<void> | null = null;
}

export class BinaryFile implements FileHandle {
  readonly kind = "file";
  readonly name: string;
  readonly path: string;
  bytes: Uint8Array<ArrayBuffer>;
  private disk: FixtureDisk;

  constructor(
    disk: FixtureDisk,
    name: string,
    path: string,
    bytes: Uint8Array<ArrayBuffer>,
  ) {
    this.disk = disk;
    this.name = name;
    this.path = path;
    this.bytes = bytes;
  }

  async isSameEntry(other: HandleBase): Promise<boolean> {
    return this === other;
  }

  async getFile(): Promise<File> {
    if (this.disk.state !== "granted")
      throw new DOMException("Access denied.", "NotAllowedError");
    return new File([this.bytes.slice()], this.name);
  }

  async createWritable(): Promise<WritableHandle> {
    if (this.disk.state !== "granted")
      throw new DOMException("Access denied.", "NotAllowedError");
    if (
      this.path === PREPARATION_MANIFEST_FILENAME &&
      this.disk.failPreparationManifest
    )
      throw new DOMException(
        "Write failed.",
        this.disk.failPreparationManifest,
      );
    let pending: Uint8Array<ArrayBuffer> | undefined;
    let text = false;
    return {
      write: async (data, signal) => {
        if (typeof data === "string") {
          pending = new TextEncoder().encode(data);
          text = true;
          return;
        }
        if (this.disk.holdAudio) await this.disk.holdAudio;
        signal?.throwIfAborted();
        if (this.disk.failAudio)
          throw new DOMException("Write failed.", this.disk.failAudio);
        const view =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : ArrayBuffer.isView(data)
              ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              : new Uint8Array(await (data as Blob).arrayBuffer());
        pending = new Uint8Array(view);
      },
      close: async () => {
        if (this.disk.state !== "granted")
          throw new DOMException("Access denied.", "NotAllowedError");
        if (pending) this.bytes = pending;
        this.disk.writes.push({
          path: this.path,
          kind: text ? "text" : "audio",
        });
      },
      abort: async () => undefined,
    };
  }
}

export class BinaryFolder implements DirectoryHandle {
  readonly kind = "directory";
  readonly name: string;
  readonly path: string;
  readonly disk: FixtureDisk;
  children = new Map<string, BinaryFolder | BinaryFile>();

  constructor(disk = new FixtureDisk(), name = "samples", path = "") {
    this.disk = disk;
    this.name = name;
    this.path = path;
  }

  async isSameEntry(other: HandleBase): Promise<boolean> {
    return this === other;
  }
  async queryPermission(): Promise<AccessState> {
    return this.disk.state;
  }
  async requestPermission(): Promise<AccessState> {
    return this.disk.state;
  }

  private check() {
    if (this.disk.state !== "granted")
      throw new DOMException("Access denied.", "NotAllowedError");
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<BinaryFile> {
    this.check();
    const existing = this.children.get(name);
    if (existing?.kind === "file") return existing;
    if (existing) throw new DOMException("Wrong type.", "TypeMismatchError");
    if (!options?.create) throw new DOMException("Missing.", "NotFoundError");
    return this.file(name, new Uint8Array(0));
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<BinaryFolder> {
    this.check();
    const existing = this.children.get(name);
    if (existing?.kind === "directory") return existing;
    if (existing) throw new DOMException("Wrong type.", "TypeMismatchError");
    if (!options?.create) throw new DOMException("Missing.", "NotFoundError");
    return this.folder(name);
  }

  async *entries(): AsyncIterableIterator<[string, BinaryFolder | BinaryFile]> {
    this.check();
    yield* this.children.entries();
  }

  async resolve(): Promise<string[] | null> {
    return null;
  }

  async removeEntry(name: string): Promise<void> {
    this.check();
    this.disk.removals.push(this.path ? `${this.path}/${name}` : name);
    this.children.delete(name);
  }

  file(name: string, bytes: Uint8Array<ArrayBuffer>): BinaryFile {
    const file = new BinaryFile(
      this.disk,
      name,
      this.path ? `${this.path}/${name}` : name,
      bytes,
    );
    this.children.set(name, file);
    return file;
  }

  folder(name: string): BinaryFolder {
    const child = new BinaryFolder(
      this.disk,
      name,
      this.path ? `${this.path}/${name}` : name,
    );
    this.children.set(name, child);
    return child;
  }

  /** Add a file at a relative path, with its parent folders. */
  put(path: string, bytes: Uint8Array<ArrayBuffer>): BinaryFile {
    const parts = path.split("/");
    let folder: BinaryFolder = this;
    for (const part of parts.slice(0, -1)) {
      const child = folder.children.get(part);
      folder = child?.kind === "directory" ? child : folder.folder(part);
    }
    return folder.file(parts.at(-1)!, bytes);
  }

  at(path: string): BinaryFile | undefined {
    const parts = path.split("/");
    let node: BinaryFolder | BinaryFile | undefined = this;
    for (const part of parts) {
      if (node?.kind !== "directory") return undefined;
      node = node.children.get(part);
    }
    return node?.kind === "file" ? node : undefined;
  }

  text(path: string): string | undefined {
    const file = this.at(path);
    return file ? new TextDecoder().decode(file.bytes) : undefined;
  }

  /** Hash every WAV file in the tree. */
  audio(): Record<string, string> {
    const result: Record<string, string> = {};
    const visit = (folder: BinaryFolder) => {
      for (const child of folder.children.values()) {
        if (child.kind === "directory") visit(child);
        else if (/\.wav$/iu.test(child.name))
          result[child.path] = createHash("sha256")
            .update(child.bytes)
            .digest("hex");
      }
    };
    visit(this);
    return result;
  }
}

/** Run the Worker code in this thread. A gate holds work at a checkpoint. */
export class DirectRunner implements PreparationRunner {
  paused = false;
  starts = 0;
  stages: string[] = [];
  gate: Promise<void> | null = null;
  /** Hold only in this stage. Without a stage, the gate holds at each checkpoint. */
  holdStage: string | null = null;
  /** Ignore cancellation and resolve later, as a stale Worker reply would. */
  ignoreAbort = false;
  late: Promise<PrepareOutcome> | undefined;
  private resumeWaiters: Array<() => void> = [];

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused) {
      const waiters = this.resumeWaiters;
      this.resumeWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  async run(
    request: PreparationRequest,
    { signal, onProgress }: PreparationRun,
  ): Promise<PrepareOutcome> {
    this.starts++;
    const bytes = await request.file.arrayBuffer();
    const work = prepareAudio(bytes, request.sourceSha256, request.plan, {
      progress: (stage, fraction) => {
        if (this.stages.at(-1) !== stage) this.stages.push(stage);
        onProgress(stage, fraction);
      },
      checkpoint: async () => {
        if (
          this.gate &&
          (!this.holdStage || this.stages.at(-1) === this.holdStage)
        )
          await this.gate;
        while (this.paused)
          await new Promise<void>((resolve) =>
            this.resumeWaiters.push(resolve),
          );
        if (!this.ignoreAbort) signal.throwIfAborted();
      },
    });
    this.late = work;
    if (this.ignoreAbort) return work;
    return new Promise((resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Preparation stopped.", "AbortError")),
        { once: true },
      );
      work.then(resolve, reject);
    });
  }
}

export function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
