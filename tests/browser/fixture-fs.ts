import type { Page } from "@playwright/test";
import type { EntryResult } from "../../src/domain/entry.ts";
import type {
  DirectoryHandle,
  FileHandle,
  HandleBase,
  WritableHandle,
} from "../../src/storage/handles.ts";

export type SampleFixture = "valid" | "empty" | "corrupt" | "mp3" | "slow";
export interface FixtureOptions {
  settings?: string;
  recovery?: Record<string, string>;
  unavailablePersistence?: boolean;
  library?: boolean;
  extraSamples?: number;
  sampleMetadata?: Record<string, string>;
}
export interface FixtureSnapshot {
  entries: Array<Omit<EntryResult, "samples" | "settings">>;
  audio: Array<{ path: string; hash: string }>;
  selectedAudio: Array<{ path: string; hash: string }>;
  writes: Array<{ path: string; contents: string }>;
  removals: string[];
  settings: string | null;
  recovery: Record<string, string>;
  sampleMetadata: Record<string, string>;
}
export interface FixtureControls {
  queueSample(kind: SampleFixture): void;
  cancelPicker(kind: "samples" | "settings"): void;
  setPermission(
    kind: "samples" | "settings",
    state: "granted" | "denied" | "prompt",
  ): void;
  failSettingsWrite(value: boolean): void;
  failTagWrite(value: boolean): void;
  releaseSlow(): void;
  blockAudioWrite(): void;
  audioWriteStarted(): boolean;
  releaseAudioWrite(): void;
  changeSelectedAudio(path: string): void;
  snapshot(): Promise<FixtureSnapshot>;
}

declare global {
  interface Window {
    fixtureFS: FixtureControls;
    fixtureLoadMetadata(): Promise<Record<string, string>>;
    fixtureSaveMetadata(path: string, contents: string | null): Promise<void>;
  }
}

/** Replace browser APIs before app startup. No application test API is required. */
export async function installFixtureFS(
  page: Page,
  options: FixtureOptions = {},
) {
  // These files belong to the test host, outside browser storage.
  const persistedMetadata = new Map<string, string>();
  await page.exposeBinding("fixtureLoadMetadata", () =>
    Object.fromEntries(persistedMetadata),
  );
  await page.exposeBinding(
    "fixtureSaveMetadata",
    (_source, path: string, contents: string | null) => {
      if (contents === null) persistedMetadata.delete(path);
      else persistedMetadata.set(path, contents);
    },
  );
  await page.addInitScript((configuration) => {
    const writes: FixtureSnapshot["writes"] = [];
    const removals: string[] = [];
    const entries: FixtureSnapshot["entries"] = [];
    const selection: SampleFixture[] = [];
    const cancelled = new Set<string>();
    let failSettings = false;
    let failTags = false;
    let holdAudioWrite = false;
    let audioWriteStarted = false;
    let releaseAudioWrite = () => {};
    let audioWriteGate: Promise<void> = Promise.resolve();
    let releaseSlow = () => {};
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();
    class MemoryFile implements FileHandle {
      readonly kind = "file";
      name: string;
      path: string;
      bytes: Uint8Array<ArrayBuffer>;
      modified = 1_700_000_000_000;
      constructor(name: string, path: string, bytes: Uint8Array<ArrayBuffer>) {
        this.name = name;
        this.path = path;
        this.bytes = bytes;
      }
      async isSameEntry(other: HandleBase): Promise<boolean> {
        return this === other;
      }
      async getFile() {
        return new File([this.bytes], this.name, {
          lastModified: this.modified,
        });
      }
      async createWritable(): Promise<WritableHandle> {
        let pending: Uint8Array<ArrayBuffer> = new Uint8Array(0);
        return {
          write: async (value) => {
            if (typeof value !== "string" && holdAudioWrite) {
              audioWriteStarted = true;
              await audioWriteGate;
            }
            if (typeof value === "string") {
              pending = textEncoder.encode(value);
              writes.push({ path: this.path, contents: value });
            } else if (value instanceof Blob) {
              pending = new Uint8Array(await value.arrayBuffer());
            } else if (ArrayBuffer.isView(value)) {
              pending = new Uint8Array(value.byteLength);
              pending.set(
                new Uint8Array(
                  value.buffer,
                  value.byteOffset,
                  value.byteLength,
                ),
              );
            } else {
              pending = new Uint8Array(value);
            }
          },
          close: async () => {
            if (failSettings && this.name === "ravefold-settings.json")
              throw new DOMException("Write denied.", "NotAllowedError");
            if (
              failTags &&
              this.path.startsWith("Sample library/") &&
              this.name.endsWith(".json") &&
              !this.name.startsWith(".ravefold-access-")
            )
              throw new DOMException("Write denied.", "NotAllowedError");
            this.bytes = pending;
            this.modified = Date.now();
            if (this.name.endsWith(".json"))
              await window.fixtureSaveMetadata(
                this.path,
                textDecoder.decode(this.bytes),
              );
          },
          abort: async () => {},
        };
      }
    }
    class MemoryDirectory implements DirectoryHandle {
      readonly kind = "directory";
      name: string;
      path: string;
      state: "granted" | "denied" | "prompt" = "granted";
      children = new Map<string, MemoryDirectory | MemoryFile>();
      delayed = false;
      constructor(name: string, path = name) {
        this.name = name;
        this.path = path;
      }
      async isSameEntry(other: HandleBase): Promise<boolean> {
        return this === other;
      }
      async queryPermission() {
        return this.state;
      }
      async requestPermission() {
        return this.state;
      }
      async getFileHandle(name: string, options?: { create?: boolean }) {
        if (this.state !== "granted")
          throw new DOMException("Access denied.", "NotAllowedError");
        const existing = this.children.get(name);
        if (existing?.kind === "file") return existing;
        if (existing)
          throw new DOMException("Not a file.", "TypeMismatchError");
        if (!options?.create)
          throw new DOMException("Missing file.", "NotFoundError");
        return this.file(name, "");
      }
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        if (this.state !== "granted")
          throw new DOMException("Access denied.", "NotAllowedError");
        const existing = this.children.get(name);
        if (existing?.kind === "directory") return existing;
        if (existing)
          throw new DOMException("Not a directory.", "TypeMismatchError");
        if (options?.create) return this.folder(name);
        throw new DOMException("Missing folder.", "NotFoundError");
      }
      async *entries(): AsyncIterableIterator<
        [string, MemoryDirectory | MemoryFile]
      > {
        if (this.delayed) await slow;
        if (this.state !== "granted")
          throw new DOMException("Access denied.", "NotAllowedError");
        yield* this.children.entries();
      }
      async resolve(other: HandleBase): Promise<string[] | null> {
        if (this === other) return [];
        if (!(other instanceof MemoryDirectory)) return null;
        return other.path.startsWith(`${this.path}/`)
          ? other.path.slice(this.path.length + 1).split("/")
          : null;
      }
      async removeEntry(name: string) {
        removals.push(`${this.path}/${name}`);
        this.children.delete(name);
        await window.fixtureSaveMetadata(`${this.path}/${name}`, null);
      }
      file(name: string, value: string | Uint8Array<ArrayBuffer>) {
        const file = new MemoryFile(
          name,
          `${this.path}/${name}`,
          typeof value === "string" ? textEncoder.encode(value) : value,
        );
        this.children.set(name, file);
        return file;
      }
      folder(name: string) {
        const folder = new MemoryDirectory(name, `${this.path}/${name}`);
        this.children.set(name, folder);
        return folder;
      }
    }
    const wav = new Uint8Array(48);
    const view = new DataView(wav.buffer);
    const text = (offset: number, value: string) =>
      wav.set(textEncoder.encode(value), offset);
    text(0, "RIFF");
    view.setUint32(4, 40, true);
    text(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 48000, true);
    view.setUint32(28, 96000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, 4, true);
    view.setInt16(44, 12000, true);
    view.setInt16(46, -12000, true);
    const samples = new MemoryDirectory("Sample library");
    function signal(frequency: number): Uint8Array<ArrayBuffer> {
      const frames = 48000 * 8;
      const bytes = new Uint8Array(44 + frames * 2);
      bytes.set(wav.subarray(0, 44));
      const data = new DataView(bytes.buffer);
      data.setUint32(4, bytes.length - 8, true);
      data.setUint32(40, frames * 2, true);
      for (let frame = 0; frame < frames; frame++)
        data.setInt16(
          44 + frame * 2,
          Math.round(
            Math.sin((frame * frequency * 2 * Math.PI) / 48000) * 4000,
          ),
          true,
        );
      return bytes;
    }
    samples
      .folder("Drums")
      .file("kick.wav", configuration.library ? signal(80) : wav);
    if (configuration.library) {
      const loops = samples.folder("Loops");
      loops.file("kick.wav", signal(160));
      loops.file("acid.wav", signal(320));
    }
    if (configuration.extraSamples) {
      const catalog = samples.folder("Catalog");
      for (let index = 0; index < configuration.extraSamples; index++)
        catalog.file(`sample-${String(index).padStart(4, "0")}.wav`, wav);
    }
    const alternatives: Record<SampleFixture, MemoryDirectory> = {
      valid: samples,
      empty: new MemoryDirectory("Empty samples"),
      corrupt: new MemoryDirectory("Corrupt samples"),
      mp3: new MemoryDirectory("MP3 samples"),
      slow: new MemoryDirectory("Slow samples"),
    };
    alternatives.corrupt.file("broken.wav", "not a waveform");
    alternatives.mp3.file("song.mp3", wav);
    alternatives.slow.file("slow.wav", wav);
    alternatives.slow.delayed = true;
    const settings = new MemoryDirectory("RaveFold settings");
    if (configuration.settings !== undefined)
      settings.file("ravefold-settings.json", configuration.settings);
    if (configuration.recovery) {
      const recovery = settings.folder("recovery");
      for (const [name, value] of Object.entries(configuration.recovery))
        recovery.file(name, value);
    }
    function restoreFile(
      root: MemoryDirectory,
      path: string,
      contents: string,
    ) {
      const parts = path.split("/");
      let folder = root;
      for (const part of parts.slice(0, -1)) {
        const existing = folder.children.get(part);
        folder =
          existing?.kind === "directory" ? existing : folder.folder(part);
      }
      folder.file(parts.at(-1)!, contents);
    }
    for (const [path, contents] of Object.entries(
      configuration.sampleMetadata ?? {},
    ))
      restoreFile(samples, path, contents);
    let restored = false;
    async function restoreMetadata() {
      if (restored) return;
      restored = true;
      for (const [path, contents] of Object.entries(
        await window.fixtureLoadMetadata(),
      )) {
        const root = path.startsWith(`${samples.name}/`) ? samples : settings;
        restoreFile(root, path.slice(root.name.length + 1), contents);
      }
    }
    let selectedSamples = samples;
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async ({ id }: { id: string }) => {
        await restoreMetadata();
        const kind = id === "ravefold-settings" ? "settings" : "samples";
        if (cancelled.delete(kind))
          throw new DOMException("Selection cancelled.", "AbortError");
        if (kind === "settings") return settings;
        selectedSamples = alternatives[selection.shift() ?? "valid"];
        return selectedSamples;
      },
    });
    if (configuration.unavailablePersistence) {
      Object.defineProperty(window, "indexedDB", {
        configurable: true,
        get: () => {
          throw new DOMException("Storage unavailable.", "SecurityError");
        },
      });
    }
    window.addEventListener("ravefold:entry", (event) => {
      const { mode, project, missingSamples, appearance } = (
        event as CustomEvent<EntryResult>
      ).detail;
      entries.push(
        structuredClone({ mode, project, missingSamples, appearance }),
      );
    });
    function allFiles(directory: MemoryDirectory): MemoryFile[] {
      return [...directory.children.values()].flatMap((child) =>
        child.kind === "file" ? [child] : allFiles(child),
      );
    }
    async function audioIn(directory: MemoryDirectory) {
      return Promise.all(
        allFiles(directory)
          .filter((file) => file.name.toLowerCase().endsWith(".wav"))
          .map(async (file) => ({
            path: file.path,
            hash: [
              ...new Uint8Array(
                await crypto.subtle.digest("SHA-256", file.bytes),
              ),
            ]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join(""),
          })),
      );
    }
    window.fixtureFS = {
      queueSample: (kind) => selection.push(kind),
      cancelPicker: (kind) => {
        cancelled.add(kind);
      },
      setPermission: (kind, state) => {
        (kind === "samples" ? selectedSamples : settings).state = state;
      },
      failSettingsWrite: (value) => {
        failSettings = value;
      },
      failTagWrite: (value) => {
        failTags = value;
      },
      releaseSlow,
      blockAudioWrite: () => {
        holdAudioWrite = true;
        audioWriteStarted = false;
        audioWriteGate = new Promise<void>((resolve) => {
          releaseAudioWrite = resolve;
        });
      },
      audioWriteStarted: () => audioWriteStarted,
      releaseAudioWrite: () => {
        holdAudioWrite = false;
        releaseAudioWrite();
      },
      changeSelectedAudio: (path) => {
        const parts = path.split("/");
        let folder = selectedSamples;
        for (const name of parts.slice(0, -1)) {
          const child = folder.children.get(name);
          if (child?.kind !== "directory")
            throw new Error("Missing test folder.");
          folder = child;
        }
        const file = folder.children.get(parts.at(-1)!);
        if (file?.kind !== "file" || file.bytes.length <= 44)
          throw new Error("Missing test WAV file.");
        file.bytes = file.bytes.slice();
        file.bytes[44] ^= 1;
        file.modified++;
      },
      snapshot: async () => ({
        entries,
        writes,
        removals,
        audio: await audioIn(samples),
        selectedAudio: await audioIn(selectedSamples),
        settings:
          settings.children.get("ravefold-settings.json")?.kind === "file"
            ? textDecoder.decode(
                (settings.children.get("ravefold-settings.json") as MemoryFile)
                  .bytes,
              )
            : null,
        recovery: Object.fromEntries(
          allFiles(settings)
            .filter((file) => file.path.includes("/recovery/"))
            .map((file) => [file.name, textDecoder.decode(file.bytes)]),
        ),
        sampleMetadata: Object.fromEntries(
          allFiles(samples)
            .filter((file) => file.name.endsWith(".json"))
            .map((file) => [
              file.path.slice(samples.name.length + 1),
              textDecoder.decode(file.bytes),
            ]),
        ),
      }),
    };
  }, options);
}

export async function snapshotFS(page: Page): Promise<FixtureSnapshot> {
  return page.evaluate(() => window.fixtureFS.snapshot());
}
