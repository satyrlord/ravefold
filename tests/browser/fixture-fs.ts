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
}
export interface FixtureSnapshot {
  entries: Array<Omit<EntryResult, "samples" | "settings">>;
  audio: Array<{ path: string; hash: string }>;
  writes: Array<{ path: string; contents: string }>;
  removals: string[];
  settings: string | null;
  recovery: Record<string, string>;
}
export interface FixtureControls {
  queueSample(kind: SampleFixture): void;
  cancelPicker(kind: "samples" | "settings"): void;
  setPermission(
    kind: "samples" | "settings",
    state: "granted" | "denied" | "prompt",
  ): void;
  failSettingsWrite(value: boolean): void;
  releaseSlow(): void;
  snapshot(): Promise<FixtureSnapshot>;
}

declare global {
  interface Window {
    fixtureFS: FixtureControls;
  }
}

/** Replace browser APIs before app startup. No application test API is required. */
export async function installFixtureFS(
  page: Page,
  options: FixtureOptions = {},
) {
  await page.addInitScript((configuration) => {
    const writes: FixtureSnapshot["writes"] = [];
    const removals: string[] = [];
    const entries: FixtureSnapshot["entries"] = [];
    const selection: SampleFixture[] = [];
    const cancelled = new Set<string>();
    let failSettings = false;
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
      constructor(name: string, path: string, bytes: Uint8Array<ArrayBuffer>) {
        this.name = name;
        this.path = path;
        this.bytes = bytes;
      }
      async isSameEntry(other: HandleBase): Promise<boolean> {
        return this === other;
      }
      async getFile() {
        return new File([this.bytes], this.name);
      }
      async createWritable(): Promise<WritableHandle> {
        let pending: Uint8Array<ArrayBuffer> = new Uint8Array(0);
        return {
          write: async (value) => {
            if (typeof value !== "string")
              throw new Error("The test expects JSON writes only.");
            pending = textEncoder.encode(value);
            writes.push({ path: this.path, contents: value });
          },
          close: async () => {
            if (failSettings && this.name === "ravefold-settings.json")
              throw new DOMException("Write denied.", "NotAllowedError");
            this.bytes = pending;
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
      async getDirectoryHandle(name: string) {
        if (this.state !== "granted")
          throw new DOMException("Access denied.", "NotAllowedError");
        const existing = this.children.get(name);
        if (existing?.kind === "directory") return existing;
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
    samples.folder("Drums").file("kick.wav", wav);
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
    let selectedSamples = samples;
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async ({ id }: { id: string }) => {
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
      releaseSlow,
      snapshot: async () => ({
        entries,
        writes,
        removals,
        audio: await Promise.all(
          allFiles(samples)
            .filter((file) => file.name.endsWith(".wav"))
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
        ),
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
      }),
    };
  }, options);
}

export async function snapshotFS(page: Page): Promise<FixtureSnapshot> {
  return page.evaluate(() => window.fixtureFS.snapshot());
}
