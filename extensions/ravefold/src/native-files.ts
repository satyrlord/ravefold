import { randomUUID } from "node:crypto";
import { constants, openAsBlob, type Dir, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle as NodeFileHandle } from "node:fs/promises";
import * as path from "node:path";
import {
  MAX_SETTINGS_BYTES,
  parseSettings,
} from "../../../src/domain/settings.ts";
import {
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  type NativeHandle,
} from "../../../shared/native-protocol.ts";
import { validateWav } from "../../../src/domain/wav.ts";
import {
  MAX_TAGS_BYTES,
  parseTagManifest,
  TAGS_FILENAME,
  TAGS_LOCK_FILENAME,
} from "../../../src/domain/library-tags.ts";
import {
  MAX_TAG_RESERVATION_BYTES,
  parseTagReservation,
  TAG_RESERVATION_PATTERN,
  TAG_RESERVATION_BUSY_MESSAGE,
} from "../../../src/domain/tag-reservation.ts";

export type { NativeHandle } from "../../../shared/native-protocol.ts";

type Role = "samples" | "settings";
type FileStat = Stats;
interface Grant {
  id: string;
  path: string;
  identity: string;
  role: Role;
}
interface Entry {
  descriptor: NativeHandle;
  grant: Grant;
  parts: string[];
  pending?: boolean;
  owned?: "probe" | "settings" | "tags" | "tag-register" | "audio";
  version?: string;
}
interface MetadataWriter {
  kind: "probe" | "settings" | "tags" | "tag-register";
  entry: Entry;
  version: string;
  text?: string;
  tagLock?: TagLock;
}
interface TagLock {
  path: string;
  identity: string;
  contents: string;
}
interface OwnedRegister {
  grant: Grant;
  name: string;
  version: string;
}
interface AudioWriter {
  kind: "audio";
  entry: Entry;
  temporary: string;
  file: NodeFileHandle;
  identity: string;
  bytes: number;
}
type Writer = MetadataWriter | AudioWriter;
interface Cursor {
  entry: Entry;
  directory: Dir;
}

const settingsName = "ravefold-settings.json";
const probePattern =
  /^\.ravefold-access-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.manifest\.json$/u;

function fail(name: string, message: string): never {
  const error = new Error(message);
  error.name = name;
  throw error;
}

function named(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function identity(stat: FileStat): string {
  return `${stat.dev}:${stat.ino}`;
}

function version(stat: FileStat): string {
  return `${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function validComponent(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !!value &&
    value !== "." &&
    value !== ".." &&
    !/[\\/:\0]/u.test(value) &&
    !/[. ]$/u.test(value) &&
    value.length <= 255
  );
}

function component(value: unknown): string {
  if (!validComponent(value))
    fail("SecurityError", "The file name is not permitted.");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length > 1024)
    fail("TypeError", "The request is not valid.");
  return value;
}

function integer(value: unknown, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  )
    fail("TypeError", "The request range is not valid.");
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("TypeError", "The request is not valid.");
  return value as Record<string, unknown>;
}

function fields(request: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(request).some((key) => !["op", ...allowed].includes(key)))
    fail("TypeError", "The request has unsupported fields.");
}

/** The extension supplies paths only after a native picker or saved grant. */
export class NativeFiles {
  private grants = new Map<string, Grant>();
  private roots = new Map<Role, Grant>();
  private rememberedRoots = new Map<
    string,
    { path: string; identity: string }
  >();
  private retainedRegisters = new Map<string, OwnedRegister>();
  private entries = new Map<string, Entry>();
  private pathEntries = new Map<string, Map<string, Entry>>();
  private writers = new Map<string, Writer>();
  private cursors = new Map<string, Cursor>();
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();

  async selectRoot(role: Role, absolutePath: string): Promise<NativeHandle> {
    this.active();
    return this.grantRoot(role, await this.canonical(absolutePath));
  }

  private async grantRoot(
    role: Role,
    canonical: { path: string; identity: string },
  ): Promise<NativeHandle> {
    this.active();
    if (role !== "samples" && role !== "settings")
      fail("TypeError", "The folder role is not valid.");
    const other = this.roots.get(role === "samples" ? "settings" : "samples");
    if (
      other &&
      (within(other.path, canonical.path) || within(canonical.path, other.path))
    )
      fail(
        "SecurityError",
        "Select separate folders. Neither folder can contain the other.",
      );
    const previous = this.roots.get(role);
    if (previous) await this.revoke(previous);
    const grant: Grant = { ...canonical, id: randomUUID(), role };
    this.grants.set(grant.id, grant);
    this.roots.set(role, grant);
    this.pathEntries.set(grant.id, new Map());
    const root = this.addEntry(grant, [], "directory").descriptor;
    this.rememberedRoots.set(root.id, canonical);
    for (const [name, record] of this.retainedRegisters) {
      if (
        record.grant.path === canonical.path &&
        record.grant.identity === canonical.identity &&
        (await this.releaseOwnedRegister(record))
      )
        this.retainedRegisters.delete(name);
    }
    return root;
  }

  async restoreRoot(
    role: Role,
    absolutePath: string,
    expectedIdentity: string,
  ): Promise<NativeHandle> {
    this.active();
    if (
      typeof absolutePath !== "string" ||
      !path.isAbsolute(absolutePath) ||
      typeof expectedIdentity !== "string" ||
      !expectedIdentity ||
      expectedIdentity.length > 128
    )
      fail("SecurityError", "The saved folder reference is not valid.");
    const selected = await fs.lstat(absolutePath);
    if (
      selected.isSymbolicLink() ||
      !selected.isDirectory() ||
      identity(selected) !== expectedIdentity
    )
      fail("SecurityError", "The saved folder changed. Select it again.");
    const canonical = await this.canonical(absolutePath);
    if (
      canonical.path !== absolutePath ||
      canonical.identity !== expectedIdentity
    )
      fail("SecurityError", "The saved folder changed. Select it again.");
    return this.grantRoot(role, canonical);
  }

  /** This method is host-only. Never send its result to the webview. */
  rootPath(role: Role): string | undefined {
    return this.roots.get(role)?.path;
  }

  referenceFor(id: string): { role: Role; path: string; identity: string } {
    const entry = this.entry(id, "directory");
    if (entry.parts.length)
      fail("NotAllowedError", "Only a selected root can be remembered.");
    return {
      role: entry.grant.role,
      path: entry.grant.path,
      identity: entry.grant.identity,
    };
  }

  async dispatch(request: unknown): Promise<unknown> {
    const job = this.queue.then(async () => {
      try {
        this.active();
        return await this.operation(record(request));
      } catch (error) {
        if (named(error, "ENOENT"))
          fail("NotFoundError", "The selected file or folder is unavailable.");
        if (named(error, "EACCES") || named(error, "EPERM"))
          fail("NotAllowedError", "Read and write permission is required.");
        if (named(error, "EEXIST"))
          fail(
            "InvalidModificationError",
            "The file changed in another session.",
          );
        if (
          error instanceof Error &&
          [
            "SecurityError",
            "TypeError",
            "NotFoundError",
            "NotAllowedError",
            "TypeMismatchError",
            "InvalidStateError",
            "InvalidModificationError",
            "NoModificationAllowedError",
            "AbortError",
            "QuotaExceededError",
          ].includes(error.name)
        )
          throw error;
        fail(
          "NotReadableError",
          "The selected file operation could not complete.",
        );
      }
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.queue;
    for (const cursor of this.cursors.values())
      await cursor.directory.close().catch(() => undefined);
    this.cursors.clear();
    for (const writer of this.writers.values())
      await this.discardWriter(writer);
    this.writers.clear();
    await this.cleanupRegisters();
    this.entries.clear();
    this.pathEntries.clear();
    this.grants.clear();
    this.roots.clear();
    this.rememberedRoots.clear();
    this.retainedRegisters.clear();
  }

  async revokeAll(): Promise<void> {
    await this.queue;
    this.active();
    for (const grant of [...this.grants.values()]) await this.revoke(grant);
    this.roots.clear();
  }

  private active(): void {
    if (this.disposed) fail("AbortError", "The native session is closed.");
  }

  private async canonical(
    input: string,
  ): Promise<{ path: string; identity: string }> {
    if (typeof input !== "string" || !path.isAbsolute(input))
      fail("SecurityError", "Select a local file or folder.");
    const canonical = await fs.realpath(input);
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory())
      fail("TypeMismatchError", "The selected entry has the wrong type.");
    return { path: canonical, identity: identity(stat) };
  }

  private async revoke(grant: Grant): Promise<void> {
    await this.cleanupRegisters(grant);
    this.grants.delete(grant.id);
    for (const [id, cursor] of this.cursors) {
      if (cursor.entry.grant === grant) {
        await cursor.directory.close().catch(() => undefined);
        this.cursors.delete(id);
      }
    }
    for (const [id, writer] of this.writers) {
      if (writer.entry.grant === grant) {
        this.writers.delete(id);
        await this.discardWriter(writer);
      }
    }
    for (const entry of this.pathEntries.get(grant.id)?.values() ?? [])
      this.entries.delete(entry.descriptor.id);
    this.pathEntries.delete(grant.id);
  }

  private async cleanupRegisters(grant?: Grant): Promise<void> {
    for (const entry of this.entries.values()) {
      if (
        entry.owned !== "tag-register" ||
        !entry.version ||
        (grant && entry.grant !== grant)
      )
        continue;
      const name = entry.descriptor.name;
      this.retainedRegisters.set(name, {
        grant: entry.grant,
        name,
        version: entry.version,
      });
    }
    for (const [name, record] of this.retainedRegisters) {
      if (
        (!grant || record.grant === grant) &&
        (await this.releaseOwnedRegister(record))
      )
        this.retainedRegisters.delete(name);
    }
  }

  private async releaseOwnedRegister(record: OwnedRegister): Promise<boolean> {
    try {
      const root = await fs.lstat(record.grant.path);
      if (root.isSymbolicLink() || identity(root) !== record.grant.identity)
        return true;
      const target = path.join(record.grant.path, record.name);
      const current = await fs.lstat(target);
      if (
        current.isSymbolicLink() ||
        version(current) !== record.version ||
        current.size > MAX_TAG_RESERVATION_BYTES
      )
        return true;
      parseTagReservation(await fs.readFile(target, "utf8"), record.name);
      if (version(await fs.lstat(target)) !== record.version) return true;
      await fs.unlink(target);
      return true;
    } catch (error) {
      return named(error, "ENOENT");
    }
  }

  private addEntry(
    grant: Grant,
    parts: string[],
    kind: NativeHandle["kind"],
  ): Entry {
    const paths = this.pathEntries.get(grant.id);
    if (!paths)
      fail("NotAllowedError", "The folder grant is no longer available.");
    const key = parts.join("/");
    const existing = paths.get(key);
    if (existing) {
      if (existing.descriptor.kind !== kind)
        fail("TypeMismatchError", "The selected entry has the wrong type.");
      return existing;
    }
    const descriptor: NativeHandle = {
      id: randomUUID(),
      kind,
      name: parts.at(-1) ?? path.basename(grant.path),
    };
    const entry: Entry = { descriptor, grant, parts };
    this.entries.set(descriptor.id, entry);
    paths.set(key, entry);
    return entry;
  }

  private deleteEntry(entry: Entry): void {
    this.entries.delete(entry.descriptor.id);
    this.pathEntries.get(entry.grant.id)?.delete(entry.parts.join("/"));
  }

  private entry(id: unknown, kind?: NativeHandle["kind"]): Entry {
    const entry = this.entries.get(string(id));
    if (!entry || !this.grants.has(entry.grant.id))
      fail("NotAllowedError", "The file grant is no longer available.");
    if (kind && entry.descriptor.kind !== kind)
      fail("TypeMismatchError", "The selected entry has the wrong type.");
    return entry;
  }

  private async location(
    entry: Entry,
    allowMissing = false,
  ): Promise<{ path: string; stat?: FileStat }> {
    this.active();
    if (!this.grants.has(entry.grant.id))
      fail("NotAllowedError", "The folder grant is no longer available.");
    const root = await fs.lstat(entry.grant.path);
    if (root.isSymbolicLink() || identity(root) !== entry.grant.identity)
      fail("SecurityError", "The selected folder changed. Select it again.");
    let candidate = entry.grant.path;
    let stat: FileStat | undefined = root;
    for (let index = 0; index < entry.parts.length; index++) {
      candidate = path.join(candidate, component(entry.parts[index]));
      try {
        stat = await fs.lstat(candidate);
      } catch (error) {
        if (
          allowMissing &&
          index === entry.parts.length - 1 &&
          named(error, "ENOENT")
        ) {
          stat = undefined;
          break;
        }
        throw error;
      }
      if (stat.isSymbolicLink())
        fail(
          "SecurityError",
          "Linked entries are not available through this folder grant.",
        );
      if (index < entry.parts.length - 1 && !stat.isDirectory())
        fail("TypeMismatchError", "The selected entry has the wrong type.");
    }
    if (!within(entry.grant.path, candidate))
      fail("SecurityError", "The entry is outside the selected folder.");
    if (
      stat &&
      (entry.descriptor.kind === "file" ? !stat.isFile() : !stat.isDirectory())
    )
      fail("TypeMismatchError", "The selected entry has the wrong type.");
    return { path: candidate, stat };
  }

  private writeKind(
    entry: Entry,
  ): "probe" | "settings" | "tags" | "tag-register" | "audio" {
    const name = entry.parts.at(-1);
    if (
      entry.grant.role === "samples" &&
      entry.pending &&
      entry.owned === "audio" &&
      name &&
      /\.wav$/iu.test(name)
    )
      return "audio";
    if (entry.parts.length !== 1)
      fail("NotAllowedError", "This file cannot be changed.");
    const rootName = entry.parts[0]!;
    if (
      entry.grant.role === "samples" &&
      TAG_RESERVATION_PATTERN.test(rootName)
    ) {
      if (entry.owned !== "tag-register")
        fail(
          "NotAllowedError",
          "Only this session's tag reservation can change.",
        );
      return "tag-register";
    }
    if (probePattern.test(rootName)) {
      if (entry.owned !== "probe")
        fail(
          "NotAllowedError",
          "Only this session's access manifest can change.",
        );
      return "probe";
    }
    if (entry.grant.role === "settings" && rootName === settingsName)
      return "settings";
    if (entry.grant.role === "samples" && rootName === TAGS_FILENAME)
      return "tags";
    fail(
      "NotAllowedError",
      "Only new WAV files and approved metadata can be written.",
    );
  }

  private async readText(entry: Entry, limit: number): Promise<string> {
    const file = await this.location(entry);
    if (!file.stat || file.stat.size > limit)
      fail("QuotaExceededError", "The metadata file is too large.");
    return (
      await this.readBytes(entry, version(file.stat), 0, file.stat.size)
    ).toString("utf8");
  }

  private async readBytes(
    entry: Entry,
    expected: string,
    offset: number,
    length: number,
  ): Promise<Buffer> {
    const file = await this.location(entry, entry.pending);
    if (!file.stat && entry.pending) {
      if (expected !== "pending")
        fail("InvalidStateError", "The file changed. Read it again.");
      return Buffer.alloc(0);
    }
    if (!file.stat || version(file.stat) !== expected)
      fail("InvalidStateError", "The file changed. Read it again.");
    const opened = await fs.open(
      file.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await opened.stat();
      if (version(before) !== expected)
        fail("InvalidStateError", "The file changed. Read it again.");
      const data = Buffer.alloc(
        Math.min(length, Math.max(0, before.size - offset)),
      );
      let bytesRead = 0;
      while (bytesRead < data.length) {
        const result = await opened.read(
          data,
          bytesRead,
          data.length - bytesRead,
          offset + bytesRead,
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (version(await opened.stat()) !== expected)
        fail("InvalidStateError", "The file changed. Read it again.");
      if (bytesRead !== data.length)
        fail("InvalidStateError", "The file changed. Read it again.");
      await this.location(entry);
      return data.subarray(0, bytesRead);
    } finally {
      await opened.close();
    }
  }

  private async operation(request: Record<string, unknown>): Promise<unknown> {
    switch (request.op) {
      case "permission": {
        fields(request, ["handle"]);
        const entry = this.entry(request.handle, "directory");
        try {
          const current = await this.location(entry);
          await fs.access(current.path, constants.R_OK | constants.W_OK);
          return "granted";
        } catch {
          return "denied";
        }
      }
      case "getFile":
      case "getDirectory": {
        fields(request, ["handle", "name", "create"]);
        if (request.create !== undefined && typeof request.create !== "boolean")
          fail("TypeError", "The create option is not valid.");
        const parent = this.entry(request.handle, "directory");
        await this.location(parent);
        const name = component(request.name);
        const kind = request.op === "getFile" ? "file" : "directory";
        const child = this.addEntry(
          parent.grant,
          [...parent.parts, name],
          kind,
        );
        let location: Awaited<ReturnType<NativeFiles["location"]>>;
        try {
          location = await this.location(child, true);
        } catch (error) {
          if (!child.owned) this.deleteEntry(child);
          throw error;
        }
        if (!location.stat && !request.create) {
          if (!child.pending) this.deleteEntry(child);
          fail("NotFoundError", "The selected file or folder is unavailable.");
        }
        if (!location.stat && !child.pending) {
          if (kind === "directory") {
            if (parent.grant.role !== "samples") {
              this.deleteEntry(child);
              fail("NotAllowedError", "This folder cannot be created.");
            }
            try {
              await fs.mkdir(location.path);
              await this.location(child);
            } catch (error) {
              this.deleteEntry(child);
              throw error;
            }
          } else if (parent.parts.length === 0 && probePattern.test(name)) {
            child.owned = "probe";
            child.pending = true;
          } else if (
            parent.parts.length === 0 &&
            parent.grant.role === "samples" &&
            TAG_RESERVATION_PATTERN.test(name)
          ) {
            child.owned = "tag-register";
            child.pending = true;
          } else if (
            parent.parts.length === 0 &&
            parent.grant.role === "samples" &&
            name === TAGS_FILENAME
          ) {
            child.owned = "tags";
            child.pending = true;
          } else if (
            parent.parts.length === 0 &&
            parent.grant.role === "settings" &&
            name === settingsName
          ) {
            child.owned = "settings";
            child.pending = true;
          } else if (parent.grant.role === "samples" && /\.wav$/iu.test(name)) {
            child.owned = "audio";
            child.pending = true;
          } else {
            this.deleteEntry(child);
            fail("NotAllowedError", "This file cannot be created.");
          }
        }
        return child.descriptor;
      }
      case "same": {
        fields(request, ["handle", "other"]);
        const leftId = string(request.handle);
        const rightId = string(request.other);
        const absentId = !this.entries.has(leftId)
          ? leftId
          : !this.entries.has(rightId)
            ? rightId
            : undefined;
        if (absentId) {
          const remembered = this.rememberedRoots.get(absentId);
          const live = this.entries.get(absentId === leftId ? rightId : leftId);
          if (
            remembered &&
            live?.descriptor.kind === "directory" &&
            live.parts.length === 0
          ) {
            const current = await this.location(live);
            return (
              current.path === remembered.path &&
              !!current.stat &&
              identity(current.stat) === remembered.identity
            );
          }
        }
        const left = await this.location(this.entry(request.handle), true);
        const right = await this.location(this.entry(request.other), true);
        return (
          left.path === right.path &&
          (!left.stat ||
            !right.stat ||
            identity(left.stat) === identity(right.stat))
        );
      }
      case "resolve": {
        fields(request, ["handle", "other"]);
        const parent = await this.location(
          this.entry(request.handle, "directory"),
        );
        const child = await this.location(this.entry(request.other), true);
        if (!within(parent.path, child.path)) return null;
        const relative = path.relative(parent.path, child.path);
        return relative ? relative.split(path.sep) : [];
      }
      case "stat": {
        fields(request, ["handle"]);
        const entry = this.entry(request.handle, "file");
        const current = await this.location(entry, entry.pending);
        return {
          name: entry.descriptor.name,
          size: current.stat?.size ?? 0,
          lastModified: current.stat?.mtimeMs ?? 0,
          version: current.stat ? version(current.stat) : "pending",
        };
      }
      case "read": {
        fields(request, ["handle", "version", "offset", "length"]);
        const bytes = await this.readBytes(
          this.entry(request.handle, "file"),
          string(request.version),
          integer(request.offset, Number.MAX_SAFE_INTEGER),
          integer(request.length, MAX_READ_BYTES),
        );
        return { data: bytes.toString("base64") };
      }
      case "list":
        return this.list(request);
      case "closeList": {
        fields(request, ["cursor"]);
        const id = string(request.cursor);
        const cursor = this.cursors.get(id);
        this.cursors.delete(id);
        await cursor?.directory.close();
        return null;
      }
      case "openWriter": {
        fields(request, ["handle"]);
        const entry = this.entry(request.handle, "file");
        const kind = this.writeKind(entry);
        if ([...this.writers.values()].some((writer) => writer.entry === entry))
          fail("InvalidStateError", "This file already has an active write.");
        if (kind === "tags") return this.openTagWriter(entry);
        const current = await this.location(entry, entry.pending);
        if (current.stat) {
          if (kind === "probe" || kind === "audio")
            fail("NotAllowedError", "An existing file cannot be replaced.");
          if (kind === "tag-register") {
            if (!entry.version || entry.version !== version(current.stat))
              fail(
                "InvalidModificationError",
                "The tag reservation changed in another session.",
              );
            parseTagReservation(
              await this.readText(entry, MAX_TAG_RESERVATION_BYTES),
              entry.descriptor.name,
            );
          } else parseSettings(await this.readText(entry, MAX_SETTINGS_BYTES));
        }
        const id = randomUUID();
        if (kind === "audio") {
          const temporary = path.join(
            entry.grant.path,
            `.ravefold-write-${randomUUID()}.tmp`,
          );
          const file = await fs.open(temporary, "wx", 0o600);
          const audioWriter: AudioWriter = {
            kind,
            entry,
            temporary,
            file,
            identity: identity(await file.stat()),
            bytes: 0,
          };
          try {
            await this.location(entry, true);
          } catch (error) {
            await this.discardWriter(audioWriter);
            throw error;
          }
          this.writers.set(id, audioWriter);
          return { writer: id, kind: "audio" };
        }
        this.writers.set(id, {
          kind,
          entry,
          version: current.stat ? version(current.stat) : "pending",
        });
        return { writer: id, kind: "metadata" };
      }
      case "write": {
        fields(request, ["writer", "data"]);
        const writer = this.writer(request.writer);
        if (writer.kind === "audio")
          fail("NotAllowedError", "A WAV file requires binary data.");
        if (
          typeof request.data !== "string" ||
          Buffer.byteLength(request.data) >
            (writer.kind === "tags"
              ? MAX_TAGS_BYTES
              : writer.kind === "tag-register"
                ? MAX_TAG_RESERVATION_BYTES
                : MAX_SETTINGS_BYTES)
        )
          fail(
            "QuotaExceededError",
            "Only a small text document can be written.",
          );
        if (writer.kind === "probe") {
          if (
            request.data !==
            JSON.stringify({
              kind: "ravefold-access-check",
              name: writer.entry.descriptor.name,
            })
          )
            fail(
              "NotAllowedError",
              "The access manifest content is not valid.",
            );
        } else if (writer.kind === "tags") parseTagManifest(request.data);
        else if (writer.kind === "tag-register")
          parseTagReservation(request.data, writer.entry.descriptor.name);
        else parseSettings(request.data);
        writer.text = request.data;
        return null;
      }
      case "writeBytes": {
        fields(request, ["writer", "data"]);
        const writer = this.writer(request.writer);
        if (writer.kind !== "audio")
          fail("NotAllowedError", "Only a new WAV file accepts binary data.");
        if (
          typeof request.data !== "string" ||
          request.data.length === 0 ||
          request.data.length > Math.ceil(MAX_WRITE_BYTES / 3) * 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
            request.data,
          )
        )
          fail("TypeError", "The WAV data chunk is not valid.");
        const bytes = Buffer.from(request.data, "base64");
        if (
          bytes.length === 0 ||
          bytes.length > MAX_WRITE_BYTES ||
          bytes.toString("base64") !== request.data
        )
          fail("TypeError", "The WAV data chunk is not valid.");
        if (writer.bytes > Number.MAX_SAFE_INTEGER - bytes.length)
          fail("QuotaExceededError", "The WAV file is too large.");
        const current = await this.location(writer.entry, true);
        if (current.stat)
          fail("InvalidModificationError", "The WAV file already exists.");
        let offset = 0;
        while (offset < bytes.length) {
          const result = await writer.file.write(
            bytes,
            offset,
            bytes.length - offset,
            null,
          );
          if (result.bytesWritten === 0)
            fail("NotReadableError", "The WAV data could not be written.");
          offset += result.bytesWritten;
        }
        writer.bytes += bytes.length;
        return null;
      }
      case "closeWriter": {
        fields(request, ["writer"]);
        const id = string(request.writer);
        const writer = this.writer(id);
        try {
          if (writer.kind === "audio") await this.commitAudio(writer);
          else await this.commit(writer);
        } finally {
          this.writers.delete(id);
          await this.discardWriter(writer);
        }
        return null;
      }
      case "abortWriter": {
        fields(request, ["writer"]);
        const id = string(request.writer);
        const writer = this.writers.get(id);
        this.writers.delete(id);
        if (writer) await this.discardWriter(writer);
        return null;
      }
      case "remove":
        return this.remove(request);
      default:
        fail("TypeError", "The native operation is not supported.");
    }
  }

  private writer(id: unknown): Writer {
    const writer = this.writers.get(string(id));
    if (!writer)
      fail("InvalidStateError", "The file write is no longer available.");
    return writer;
  }

  private async list(request: Record<string, unknown>): Promise<unknown> {
    fields(request, ["handle", "cursor", "limit"]);
    const entry = this.entry(request.handle, "directory");
    const current = await this.location(entry);
    const limit =
      request.limit === undefined ? 128 : integer(request.limit, 256);
    if (limit === 0) fail("TypeError", "The page size must be positive.");
    const id =
      request.cursor === undefined ? randomUUID() : string(request.cursor);
    let cursor = this.cursors.get(id);
    if (request.cursor !== undefined && (!cursor || cursor.entry !== entry))
      fail("InvalidStateError", "The folder page is no longer available.");
    if (!cursor) {
      if (this.cursors.size >= 32)
        fail("QuotaExceededError", "Too many folder reads are active.");
      cursor = { entry, directory: await fs.opendir(current.path) };
      this.cursors.set(id, cursor);
    }
    const entries: NativeHandle[] = [];
    try {
      for (let index = 0; index < limit; index++) {
        this.active();
        const next = await cursor.directory.read();
        if (!next) {
          await cursor.directory.close();
          this.cursors.delete(id);
          return { entries };
        }
        if (
          !validComponent(next.name) ||
          next.isSymbolicLink() ||
          (!next.isFile() && !next.isDirectory())
        )
          continue;
        const child = this.addEntry(
          entry.grant,
          [...entry.parts, next.name],
          next.isDirectory() ? "directory" : "file",
        );
        const location = await this.location(child, true);
        if (!location.stat) {
          if (!child.owned) this.deleteEntry(child);
          continue;
        }
        entries.push(child.descriptor);
      }
      return { entries, cursor: id };
    } catch (error) {
      this.cursors.delete(id);
      await cursor.directory.close().catch(() => undefined);
      throw error;
    }
  }

  private async openTagWriter(
    entry: Entry,
  ): Promise<{ writer: string; kind: "metadata" }> {
    const tagLock = await this.acquireTagLock(entry);
    try {
      const current = await this.location(entry, entry.pending);
      if (current.stat)
        parseTagManifest(await this.readText(entry, MAX_TAGS_BYTES));
      const id = randomUUID();
      this.writers.set(id, {
        kind: "tags",
        entry,
        version: current.stat ? version(current.stat) : "pending",
        tagLock,
      });
      return { writer: id, kind: "metadata" };
    } catch (error) {
      await this.releaseTagLock(tagLock);
      throw error;
    }
  }

  private async acquireTagLock(entry: Entry): Promise<TagLock> {
    await this.location(entry, true);
    const target = path.join(entry.grant.path, TAGS_LOCK_FILENAME);
    let file: NodeFileHandle;
    try {
      file = await fs.open(target, "wx", 0o600);
    } catch (error) {
      if (named(error, "EEXIST"))
        fail("NoModificationAllowedError", TAG_RESERVATION_BUSY_MESSAGE);
      throw error;
    }
    let tagLock: TagLock | undefined;
    try {
      tagLock = {
        path: target,
        identity: identity(await file.stat()),
        contents:
          JSON.stringify({
            schemaVersion: 1,
            kind: "ravefold-tag-write-lock",
            owner: randomUUID(),
          }) + "\n",
      };
      await file.writeFile(tagLock.contents, "utf8");
      await file.sync();
      await file.close();
      await this.location(entry, true);
      return tagLock;
    } catch (error) {
      await file.close().catch(() => undefined);
      if (tagLock) await this.releaseTagLock(tagLock);
      throw error;
    }
  }

  private async ownsTagLock(tagLock: TagLock): Promise<boolean> {
    try {
      const current = await fs.lstat(tagLock.path);
      if (
        current.isSymbolicLink() ||
        identity(current) !== tagLock.identity ||
        current.size !== Buffer.byteLength(tagLock.contents)
      )
        return false;
      const file = await fs.open(
        tagLock.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        if (version(await file.stat()) !== version(current)) return false;
        const bytes = Buffer.alloc(Buffer.byteLength(tagLock.contents));
        const read = await file.read(bytes, 0, bytes.length, 0);
        if (
          read.bytesRead !== bytes.length ||
          bytes.toString("utf8") !== tagLock.contents
        )
          return false;
        return (
          version(await file.stat()) === version(current) &&
          version(await fs.lstat(tagLock.path)) === version(current)
        );
      } finally {
        await file.close();
      }
    } catch {
      return false;
    }
  }

  private async releaseTagLock(tagLock: TagLock): Promise<void> {
    try {
      if (await this.ownsTagLock(tagLock)) await fs.unlink(tagLock.path);
    } catch {
      // Keep reservations that this operation cannot prove it owns.
    }
  }

  private async checkTagLock(writer: MetadataWriter): Promise<void> {
    if (
      writer.kind === "tags" &&
      (!writer.tagLock || !(await this.ownsTagLock(writer.tagLock)))
    )
      fail(
        "InvalidModificationError",
        "The tag save reservation changed. Your previous tags remain unchanged.",
      );
  }

  private async discardWriter(writer: Writer): Promise<void> {
    if (writer.kind !== "audio") {
      if (writer.tagLock) await this.releaseTagLock(writer.tagLock);
      return;
    }
    await writer.file.close().catch(() => undefined);
    try {
      const staged = await fs.lstat(writer.temporary);
      if (!staged.isSymbolicLink() && identity(staged) === writer.identity)
        await fs.unlink(writer.temporary);
    } catch {
      /* Preserve any file that this operation does not own. */
    }
  }

  private async commitAudio(writer: AudioWriter): Promise<void> {
    const current = await this.location(writer.entry, true);
    if (current.stat)
      fail("InvalidModificationError", "The WAV file already exists.");
    await writer.file.sync();
    await writer.file.close();
    const staged = await fs.lstat(writer.temporary);
    if (
      staged.isSymbolicLink() ||
      identity(staged) !== writer.identity ||
      staged.size !== writer.bytes
    )
      fail("InvalidModificationError", "The WAV write changed before commit.");
    const validation = await validateWav(await openAsBlob(writer.temporary));
    if (!validation.valid) fail("TypeError", validation.reason);
    this.active();
    const checked = await this.location(writer.entry, true);
    if (checked.stat)
      fail("InvalidModificationError", "The WAV file already exists.");
    const finalStage = await fs.lstat(writer.temporary);
    if (
      finalStage.isSymbolicLink() ||
      identity(finalStage) !== writer.identity ||
      finalStage.size !== writer.bytes
    )
      fail("InvalidModificationError", "The WAV write changed before commit.");
    await fs.link(writer.temporary, checked.path);
    writer.entry.pending = false;
  }

  private async commit(writer: MetadataWriter): Promise<void> {
    if (writer.text === undefined)
      fail("InvalidStateError", "The file write has no content.");
    const entry = writer.entry;
    await this.checkTagLock(writer);
    const kind = this.writeKind(entry);
    const current = await this.location(entry, true);
    if ((current.stat ? version(current.stat) : "pending") !== writer.version)
      fail("InvalidModificationError", "The file changed in another session.");
    if (kind === "settings" && current.stat)
      parseSettings(await this.readText(entry, MAX_SETTINGS_BYTES));
    if (kind === "tags" && current.stat)
      parseTagManifest(await this.readText(entry, MAX_TAGS_BYTES));
    if (kind === "tag-register" && current.stat)
      parseTagReservation(
        await this.readText(entry, MAX_TAG_RESERVATION_BYTES),
        entry.descriptor.name,
      );
    const temporary = path.join(
      entry.grant.path,
      `.ravefold-write-${randomUUID()}.manifest.json`,
    );
    const file = await fs.open(temporary, "wx", 0o600);
    let temporaryIdentity = "";
    let committedPath: string | undefined;
    try {
      temporaryIdentity = identity(await file.stat());
      await file.writeFile(writer.text, "utf8");
      await file.sync();
      await file.close();
      this.active();
      const checked = await this.location(entry, true);
      if ((checked.stat ? version(checked.stat) : "pending") !== writer.version)
        fail(
          "InvalidModificationError",
          "The file changed in another session.",
        );
      const staged = await fs.lstat(temporary);
      if (
        staged.isSymbolicLink() ||
        identity(staged) !== temporaryIdentity ||
        staged.size !== Buffer.byteLength(writer.text) ||
        (await fs.readFile(temporary, "utf8")) !== writer.text
      )
        fail(
          "InvalidModificationError",
          "The metadata write changed before commit.",
        );
      if (writer.version === "pending") {
        await this.checkTagLock(writer);
        await fs.link(temporary, checked.path);
      } else {
        // Rename is atomic. The version check is not an operating-system
        // compare-and-swap operation against concurrent external changes.
        for (let attempt = 0; ; attempt++) {
          this.active();
          const destination = await this.location(entry);
          if (!destination.stat || version(destination.stat) !== writer.version)
            fail(
              "InvalidModificationError",
              "The file changed in another session.",
            );
          await this.checkTagLock(writer);
          const source = await fs.lstat(temporary);
          if (
            source.isSymbolicLink() ||
            identity(source) !== temporaryIdentity ||
            version(source) !== version(staged)
          )
            fail(
              "InvalidModificationError",
              "The metadata write changed before commit.",
            );
          try {
            await fs.rename(temporary, destination.path);
            break;
          } catch (error) {
            // Windows can deny replacement while another reader closes its handle.
            if (
              attempt >= 9 ||
              !(
                named(error, "EPERM") ||
                named(error, "EACCES") ||
                named(error, "EBUSY")
              )
            )
              throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
          }
        }
      }
      entry.pending = false;
      committedPath = checked.path;
    } finally {
      await file.close().catch(() => undefined);
      try {
        const stat = await fs.lstat(temporary);
        if (!stat.isSymbolicLink() && identity(stat) === temporaryIdentity)
          await fs.unlink(temporary);
      } catch {
        /* Preserve any file that this operation does not own. */
      }
    }
    if (committedPath && (kind === "probe" || kind === "tag-register")) {
      const committed = await fs.lstat(committedPath);
      if (
        !committed.isSymbolicLink() &&
        identity(committed) === temporaryIdentity
      )
        entry.version = version(committed);
    }
  }

  private async remove(request: Record<string, unknown>): Promise<null> {
    fields(request, ["handle", "name"]);
    const parent = this.entry(request.handle, "directory");
    const name = component(request.name);
    const entry = this.pathEntries
      .get(parent.grant.id)
      ?.get([...parent.parts, name].join("/"));
    if (!entry || !entry.owned)
      fail(
        "NotAllowedError",
        "Only this session's new metadata can be removed.",
      );
    const current = await this.location(entry, true);
    if (current.stat) {
      if (
        (entry.owned !== "probe" && entry.owned !== "tag-register") ||
        !entry.version ||
        version(current.stat) !== entry.version
      )
        fail("NotAllowedError", "This file cannot be removed.");
      const contents = await this.readText(entry, MAX_SETTINGS_BYTES);
      const expected =
        entry.owned === "probe"
          ? JSON.stringify({ kind: "ravefold-access-check", name })
          : contents;
      if (entry.owned === "tag-register") parseTagReservation(contents, name);
      if (contents !== expected)
        fail(
          "NotAllowedError",
          "The access manifest changed. It will remain in place.",
        );
      const checked = await this.location(entry);
      if (!checked.stat || version(checked.stat) !== version(current.stat))
        fail(
          "InvalidModificationError",
          "The access manifest changed. It will remain in place.",
        );
      await fs.unlink(checked.path);
    }
    this.deleteEntry(entry);
    return null;
  }
}
