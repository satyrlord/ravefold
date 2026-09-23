import type {
  AccessState,
  DirectoryHandle,
  FileHandle,
  HandleBase,
  WritableHandle,
} from "../src/storage/handles.ts";

export class LibraryFile implements FileHandle {
  readonly kind = "file";
  readonly name: string;
  contents: string;
  reads = 0;
  writes = 0;
  aborts = 0;
  active = 0;
  exclusive = true;
  failRead = false;
  failClose = false;
  onWrite?: () => void;
  permission: () => AccessState;

  constructor(
    name: string,
    contents: string,
    permission = (): AccessState => "granted",
  ) {
    this.name = name;
    this.contents = contents;
    this.permission = permission;
  }

  async isSameEntry(other: HandleBase): Promise<boolean> {
    return this === other;
  }

  async getFile(): Promise<File> {
    this.reads++;
    if (this.failRead || this.permission() !== "granted")
      throw new DOMException("Access denied.", "NotAllowedError");
    return new File([this.contents], this.name);
  }

  async createWritable(): Promise<WritableHandle> {
    if (this.permission() !== "granted")
      throw new DOMException("Access denied.", "NotAllowedError");
    if (this.active && this.exclusive)
      throw new DOMException("Writer is active.", "NoModificationAllowedError");
    this.active++;
    let next = "";
    let finished = false;
    return {
      write: async (data) => {
        if (typeof data !== "string")
          throw new Error("Expected text metadata.");
        this.writes++;
        next = data;
        this.onWrite?.();
      },
      close: async () => {
        if (this.failClose || this.permission() !== "granted")
          throw new DOMException("Access denied.", "NotAllowedError");
        this.contents = next;
        this.active--;
        finished = true;
      },
      abort: async () => {
        this.aborts++;
        if (!finished) this.active--;
        finished = true;
      },
    };
  }
}

export class LibraryDirectory implements DirectoryHandle {
  readonly kind = "directory";
  readonly name: string;
  children = new Map<string, LibraryDirectory | LibraryFile>();
  state: AccessState = "granted";
  removals: string[] = [];
  onCreate?: (file: LibraryFile) => void;

  constructor(name = "samples") {
    this.name = name;
  }

  async isSameEntry(other: HandleBase): Promise<boolean> {
    return this === other;
  }

  async queryPermission(): Promise<AccessState> {
    return this.state;
  }
  async requestPermission(): Promise<AccessState> {
    return this.state;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<LibraryFile> {
    const existing = this.children.get(name);
    if (existing?.kind === "file") return existing;
    if (existing) throw new DOMException("Wrong type.", "TypeMismatchError");
    if (!options?.create) throw new DOMException("Missing.", "NotFoundError");
    if (this.state !== "granted")
      throw new DOMException("Access denied.", "NotAllowedError");
    const file = this.file(name, "");
    this.onCreate?.(file);
    return file;
  }

  async getDirectoryHandle(name: string): Promise<LibraryDirectory> {
    const existing = this.children.get(name);
    if (existing?.kind === "directory") return existing;
    throw new DOMException("Missing.", "NotFoundError");
  }

  async *entries(): AsyncIterableIterator<
    [string, LibraryDirectory | LibraryFile]
  > {
    if (this.state !== "granted")
      throw new DOMException("Access denied.", "NotAllowedError");
    yield* this.children.entries();
  }

  async resolve(handle: HandleBase): Promise<string[] | null> {
    if (handle === this) return [];
    for (const [name, child] of this.children) {
      if (child === handle) return [name];
      if (child.kind === "directory") {
        const rest = await child.resolve(handle);
        if (rest) return [name, ...rest];
      }
    }
    return null;
  }

  async removeEntry(name: string): Promise<void> {
    if (this.state !== "granted")
      throw new DOMException("Access denied.", "NotAllowedError");
    this.removals.push(name);
    this.children.delete(name);
  }

  file(name: string, contents = "unchanged source audio"): LibraryFile {
    const file = new LibraryFile(name, contents, () => this.state);
    this.children.set(name, file);
    return file;
  }

  folder(name: string): LibraryDirectory {
    const child = new LibraryDirectory(name);
    this.children.set(name, child);
    return child;
  }
}
