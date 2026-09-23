import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import {
  lstat,
  realpath,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  link,
  readFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  LOCAL_CHUNK_BYTES,
  type LocalRequest,
  type LocalHandle,
} from "../shared/local-folder-protocol.ts";
import { parseSettings, MAX_SETTINGS_BYTES } from "../src/domain/settings.ts";
import {
  parseTagManifest,
  TAGS_FILENAME,
  MAX_TAGS_BYTES,
} from "../src/domain/library-tags.ts";
import {
  parseTagReservation,
  TAG_RESERVATION_PATTERN,
  MAX_TAG_RESERVATION_BYTES,
} from "../src/domain/tag-reservation.ts";
import { validateWav } from "../src/domain/wav.ts";

const PROBE = /^\.ravefold-access-[0-9a-f-]{36}\.manifest\.json$/u;
const MAX_WAV = 64 * 1024 * 1024;
type RootKind = "samples" | "settings";
interface Entry extends LocalHandle {
  root: RootKind;
  parts: string[];
  identity?: string;
  owned: boolean;
  ownedVersion?: string;
  ancestors: string[];
}
interface Root {
  location: string;
  identity: string;
  entry: Entry;
}
interface Writer {
  entry: Entry;
  temporary: string;
  file: FileHandle;
  version: string;
  size: number;
  touched: number;
}
function fail(name = "NotAllowedError"): never {
  throw new DOMException(
    "The local folder operation is unavailable or the file changed.",
    name,
  );
}
function identity(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}
function version(stat: Stats): string {
  return `${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
function safeName(name: unknown): asserts name is string {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 240 ||
    /[<>:"/\\|?*\x00-\x1f]/u.test(name) ||
    /[. ]$/u.test(name) ||
    /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(name) ||
    name === "." ||
    name === ".."
  )
    fail();
}
function missing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** A development host for the two configured folders. */
export class LocalFolderHost {
  private roots!: Record<RootKind, Root>;
  private entries = new Map<string, Entry>();
  private paths = new Map<string, Entry>();
  private unpublished = new Set<Entry>();
  private writers = new Map<string, Writer>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private writerIdleMs = 60_000;
  private expiryTimer?: ReturnType<typeof setInterval>;
  static async create(
    locations: Record<RootKind, string>,
    options: { writerIdleMs?: number } = {},
  ): Promise<LocalFolderHost> {
    try {
      const host = new LocalFolderHost();
      const roots = {} as Record<RootKind, Root>;
      for (const kind of ["samples", "settings"] as const) {
        const location = await realpath(locations[kind]);
        const stat = await lstat(location);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
        const entry: Entry = {
          id: randomUUID(),
          name: kind === "samples" ? "Samples" : "Settings",
          kind: "directory",
          root: kind,
          parts: [],
          identity: identity(stat),
          owned: false,
          ancestors: [],
        };
        roots[kind] = { location, identity: identity(stat), entry };
        host.entries.set(entry.id, entry);
      }
      const relative = path.relative(
        roots.samples.location,
        roots.settings.location,
      );
      const reverse = path.relative(
        roots.settings.location,
        roots.samples.location,
      );
      if (
        !relative ||
        (!relative.startsWith(`..${path.sep}`) &&
          relative !== ".." &&
          !path.isAbsolute(relative)) ||
        (!reverse.startsWith(`..${path.sep}`) &&
          reverse !== ".." &&
          !path.isAbsolute(reverse)) ||
        roots.samples.identity === roots.settings.identity
      )
        fail();
      host.roots = roots;
      if (options.writerIdleMs !== undefined) {
        if (
          !Number.isSafeInteger(options.writerIdleMs) ||
          options.writerIdleMs < 1
        )
          fail();
        host.writerIdleMs = options.writerIdleMs;
      }
      host.expiryTimer = setInterval(
        () => {
          host.queue = host.queue
            .then(() => host.expire())
            .catch(() => undefined);
        },
        Math.min(1000, host.writerIdleMs),
      );
      host.expiryTimer.unref();
      return host;
    } catch {
      fail();
    }
  }
  dispatch(request: LocalRequest): Promise<unknown> {
    const result = this.queue.then(async () => {
      try {
        if (this.disposed || !request || typeof request !== "object") fail();
        return await this.execute(request);
      } catch (error) {
        if (error instanceof DOMException) throw error;
        if (missing(error)) fail("NotFoundError");
        fail();
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  private descriptor(entry: Entry): LocalHandle {
    return { id: entry.id, kind: entry.kind, name: entry.name };
  }
  private get(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) fail();
    return entry;
  }
  private location(entry: Entry): string {
    return path.join(this.roots[entry.root].location, ...entry.parts);
  }
  private pathKey(location: string): string {
    return process.platform === "win32" ? location.toLowerCase() : location;
  }
  private async check(entry: Entry): Promise<Stats | undefined> {
    const root = this.roots[entry.root];
    const stat = await lstat(root.location);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      identity(stat) !== root.identity ||
      (await realpath(root.location)) !== root.location
    )
      fail();
    let current = root.location;
    for (let index = 0; index < entry.parts.length; index++) {
      current = path.join(current, entry.parts[index]!);
      let item: Stats;
      try {
        item = await lstat(current);
      } catch (error) {
        if (
          missing(error) &&
          index === entry.parts.length - 1 &&
          !entry.identity
        )
          return undefined;
        throw error;
      }
      if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile()))
        fail();
      if (
        index < entry.parts.length - 1 &&
        (!item.isDirectory() || identity(item) !== entry.ancestors[index])
      )
        fail();
      if (index === entry.parts.length - 1) {
        if (
          !entry.identity ||
          identity(item) !== entry.identity ||
          (entry.kind === "file") !== item.isFile()
        )
          fail("InvalidStateError");
        return item;
      }
    }
    return stat;
  }
  private limit(entry: Entry): number {
    const name = entry.name;
    if (entry.parts.length === 1) {
      if (entry.root === "settings" && name === "ravefold-settings.json")
        return MAX_SETTINGS_BYTES;
      if (entry.root === "samples" && name === TAGS_FILENAME)
        return MAX_TAGS_BYTES;
      if (PROBE.test(name)) return 256;
      if (entry.root === "samples" && TAG_RESERVATION_PATTERN.test(name))
        return MAX_TAG_RESERVATION_BYTES;
    }
    if (
      entry.root === "samples" &&
      entry.parts.length > 1 &&
      /\.wav$/iu.test(name) &&
      !entry.identity
    )
      return MAX_WAV;
    fail();
  }
  private async child(
    parent: Entry,
    name: string,
    kind: "file" | "directory",
    create = false,
  ): Promise<Entry> {
    safeName(name);
    if (
      (kind !== "file" && kind !== "directory") ||
      parent.kind !== "directory"
    )
      fail();
    await this.check(parent);
    const parts = [...parent.parts, name];
    const location = path.join(this.location(parent), name);
    let stat: Stats | undefined;
    try {
      stat = await lstat(location);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (
      stat &&
      (stat.isSymbolicLink() ||
        (kind === "file" ? !stat.isFile() : !stat.isDirectory()))
    )
      fail("TypeMismatchError");
    const previous = this.paths.get(this.pathKey(location));
    if (
      previous &&
      (stat ? previous.identity === identity(stat) : !previous.identity)
    )
      return previous;
    if (!stat && !create) fail("NotFoundError");
    const entry: Entry = {
      id: randomUUID(),
      name,
      kind,
      root: parent.root,
      parts,
      owned: !stat,
      ancestors: parent.parts.length
        ? [...parent.ancestors, parent.identity!]
        : [],
      ...(stat ? { identity: identity(stat) } : {}),
    };
    if (!stat && kind === "directory") {
      if (parent.root !== "samples") fail();
      await mkdir(location);
      entry.identity = identity(await lstat(location));
    } else if (!stat) this.limit(entry);
    this.entries.set(entry.id, entry);
    this.paths.set(this.pathKey(location), entry);
    if (!entry.identity) this.unpublished.add(entry);
    return entry;
  }
  private async execute(request: LocalRequest): Promise<unknown> {
    await this.expire();
    if (request.op === "roots") {
      await this.check(this.roots.samples.entry);
      await this.check(this.roots.settings.entry);
      return {
        samples: this.descriptor(this.roots.samples.entry),
        settings: this.descriptor(this.roots.settings.entry),
      };
    }
    if (
      request.op === "write" ||
      request.op === "close" ||
      request.op === "abort"
    ) {
      const writer = this.writers.get(request.writer);
      if (!writer) fail("InvalidStateError");
      if (request.op === "abort") {
        await this.drop(request.writer, writer);
        return null;
      }
      if (request.op === "write") {
        await this.check(writer.entry);
        if (
          typeof request.data !== "string" ||
          request.data.length > Math.ceil(LOCAL_CHUNK_BYTES / 3) * 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
            request.data,
          )
        )
          fail();
        const bytes = Buffer.from(request.data, "base64");
        if (
          bytes.length > LOCAL_CHUNK_BYTES ||
          writer.size + bytes.length > this.limit(writer.entry)
        )
          fail();
        await writer.file.writeFile(bytes);
        writer.size += bytes.length;
        writer.touched = Date.now();
        return null;
      }
      try {
        await this.commit(writer);
      } finally {
        await this.drop(request.writer, writer);
      }
      return null;
    }
    if (!("handle" in request) || typeof request.handle !== "string") fail();
    const entry = this.get(request.handle);
    const stat = await this.check(entry);
    switch (request.op) {
      case "permission":
        return "granted";
      case "child":
        return this.descriptor(
          await this.child(
            entry,
            request.name,
            request.kind,
            request.create === true,
          ),
        );
      case "entries": {
        if (entry.kind !== "directory") fail();
        const result: LocalHandle[] = [];
        for (const item of await readdir(this.location(entry), {
          withFileTypes: true,
        })) {
          if (
            [...this.writers.values()].some(
              (w) => path.basename(w.temporary) === item.name,
            )
          )
            continue;
          if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile()))
            continue;
          try {
            result.push(
              this.descriptor(
                await this.child(
                  entry,
                  item.name,
                  item.isDirectory() ? "directory" : "file",
                ),
              ),
            );
          } catch {
            /* Exclude unsupported names and links. */
          }
          if (result.length > 100_000) fail();
        }
        for (const pending of this.unpublished)
          if (
            !pending.identity &&
            pending.root === entry.root &&
            pending.parts.slice(0, -1).join("/") === entry.parts.join("/")
          )
            result.push(this.descriptor(pending));
        return result;
      }
      case "same":
      case "resolve": {
        const other = this.get(request.other);
        await this.check(other);
        const same =
          entry.root === other.root &&
          entry.parts.join("/") === other.parts.join("/") &&
          entry.identity === other.identity;
        if (request.op === "same") return same;
        return entry.kind === "directory" &&
          entry.root === other.root &&
          entry.parts.every((p, i) => p === other.parts[i])
          ? other.parts.slice(entry.parts.length)
          : null;
      }
      case "file":
        if (entry.kind !== "file") fail();
        return {
          size: stat?.size ?? 0,
          lastModified: stat?.mtimeMs ?? 0,
          version: stat ? version(stat) : entry.id,
        };
      case "read": {
        if (
          entry.kind !== "file" ||
          !Number.isSafeInteger(request.offset) ||
          request.offset < 0 ||
          !Number.isSafeInteger(request.length) ||
          request.length < 0 ||
          request.length > LOCAL_CHUNK_BYTES ||
          request.version !== (stat ? version(stat) : entry.id)
        )
          fail("NotReadableError");
        if (!stat) return "";
        const file = await open(this.location(entry), "r");
        try {
          if (version(await file.stat()) !== request.version)
            fail("NotReadableError");
          const buffer = Buffer.alloc(
            Math.min(request.length, Math.max(0, stat.size - request.offset)),
          );
          const read = await file.read(
            buffer,
            0,
            buffer.length,
            request.offset,
          );
          if (version(await file.stat()) !== request.version)
            fail("NotReadableError");
          return buffer.subarray(0, read.bytesRead).toString("base64");
        } finally {
          await file.close();
        }
      }
      case "writable": {
        if (entry.kind !== "file") fail();
        this.limit(entry);
        if (
          [...this.writers.values()].some(
            (w) => this.location(w.entry) === this.location(entry),
          )
        )
          fail("NoModificationAllowedError");
        if (stat && stat.nlink !== 1) fail();
        if (
          (PROBE.test(entry.name) ||
            TAG_RESERVATION_PATTERN.test(entry.name)) &&
          !entry.owned
        )
          fail();
        if (stat && stat.size > 0)
          this.validateMetadata(entry, await this.boundedMetadata(entry));
        const temporary = path.join(
          path.dirname(this.location(entry)),
          `.ravefold-stage-${randomUUID()}`,
        );
        const file = await open(temporary, "wx");
        const id = randomUUID();
        this.writers.set(id, {
          entry,
          temporary,
          file,
          version: stat ? version(stat) : entry.id,
          size: 0,
          touched: Date.now(),
        });
        return id;
      }
      case "remove": {
        const target = await this.child(entry, request.name, "file");
        const current = await this.check(target);
        if (
          !target.owned ||
          !(
            PROBE.test(target.name) ||
            TAG_RESERVATION_PATTERN.test(target.name) ||
            (!current && !/\.wav$/iu.test(target.name))
          )
        )
          fail();
        if (current && version(current) !== target.ownedVersion) fail();
        if ([...this.writers.values()].some((w) => w.entry === target)) fail();
        if (current) await unlink(this.location(target));
        this.entries.delete(target.id);
        this.unpublished.delete(target);
        this.paths.delete(this.pathKey(this.location(target)));
        return null;
      }
      default:
        fail();
    }
  }
  private async boundedMetadata(entry: Entry): Promise<string> {
    const stat = await this.check(entry);
    if (!stat || stat.size > this.limit(entry)) fail();
    const file = await open(this.location(entry), "r");
    try {
      if (version(await file.stat()) !== version(stat)) fail();
      const bytes = Buffer.alloc(stat.size);
      const result = await file.read(bytes, 0, bytes.length, 0);
      if (
        result.bytesRead !== bytes.length ||
        version(await file.stat()) !== version(stat)
      )
        fail();
      return bytes.toString("utf8");
    } finally {
      await file.close();
    }
  }
  private validateMetadata(entry: Entry, source: string): void {
    if (entry.name === "ravefold-settings.json") {
      parseSettings(source);
      return;
    }
    if (entry.name === TAGS_FILENAME) {
      parseTagManifest(source);
      return;
    }
    if (TAG_RESERVATION_PATTERN.test(entry.name)) {
      parseTagReservation(source, entry.name);
      return;
    }
    if (PROBE.test(entry.name)) {
      const value: unknown = JSON.parse(source);
      if (
        !value ||
        typeof value !== "object" ||
        Object.keys(value).length !== 2 ||
        !("kind" in value) ||
        value.kind !== "ravefold-access-check" ||
        !("name" in value) ||
        value.name !== entry.name
      )
        fail();
      return;
    }
    fail();
  }
  private async commit(writer: Writer): Promise<void> {
    await writer.file.sync();
    await writer.file.close();
    const entry = writer.entry;
    if (/\.wav$/iu.test(entry.name)) {
      if (!(await validateWav(await openAsBlob(writer.temporary))).valid)
        fail();
    } else
      this.validateMetadata(entry, await readFile(writer.temporary, "utf8"));
    const stat = await this.check(entry);
    if ((stat ? version(stat) : entry.id) !== writer.version)
      fail("InvalidStateError");
    if (!stat) {
      await link(writer.temporary, this.location(entry));
      await unlink(writer.temporary);
    } else await rename(writer.temporary, this.location(entry));
    const updated = await lstat(this.location(entry));
    entry.identity = identity(updated);
    this.unpublished.delete(entry);
    entry.ownedVersion = version(updated);
  }
  private async drop(id: string, writer: Writer): Promise<void> {
    this.writers.delete(id);
    await writer.file.close().catch(() => undefined);
    await unlink(writer.temporary).catch(() => undefined);
    if (!writer.entry.identity) {
      this.unpublished.delete(writer.entry);
      this.entries.delete(writer.entry.id);
      const key = this.pathKey(this.location(writer.entry));
      if (this.paths.get(key) === writer.entry) this.paths.delete(key);
    }
  }
  private async expire(): Promise<void> {
    const now = Date.now();
    for (const [id, writer] of this.writers) {
      if (now - writer.touched >= this.writerIdleMs)
        await this.drop(id, writer);
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.expiryTimer);
    await this.queue;
    for (const [id, writer] of this.writers) await this.drop(id, writer);
    for (const entry of this.entries.values()) {
      if (
        !entry.owned ||
        !entry.ownedVersion ||
        !(PROBE.test(entry.name) || TAG_RESERVATION_PATTERN.test(entry.name))
      )
        continue;
      try {
        const stat = await this.check(entry);
        if (stat && version(stat) === entry.ownedVersion)
          await unlink(this.location(entry));
      } catch {
        // Preserve files if the folder identity or file contents changed.
      }
    }
  }
}
