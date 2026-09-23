import type { DirectoryHandle } from "../storage/handles.ts";
import { validateWav, type WavInfo } from "../domain/wav.ts";
import { discoverCatalog, type CatalogResult } from "./catalog.ts";
import { readTags, saveSampleTags, type TagManifest } from "./tags.ts";

export interface LibraryState {
  catalog: CatalogResult;
  manifest?: TagManifest;
  selected: string | null;
  drafts: Record<string, string[]>;
  tagStatus: Record<string, "unsaved" | "saving" | "saved" | "error">;
  tagErrors: Record<string, string>;
  metadata?: WavInfo;
  metadataMessage: string;
  message: string;
  loading: boolean;
  tagsReadable: boolean;
}

export class LibraryController {
  private root: DirectoryHandle;
  private task = new AbortController();
  private selection = 0;
  private selectionTask?: AbortController;
  private draftBaselines = new Map<string, string[]>();
  private listeners = new Set<() => void>();
  private state: LibraryState = {
    catalog: {
      rows: [],
      folders: [""],
      inaccessible: [],
      complete: false,
      examined: 0,
    },
    selected: null,
    drafts: {},
    tagStatus: {},
    tagErrors: {},
    metadataMessage: "",
    message: "",
    loading: true,
    tagsReadable: false,
  };
  constructor(root: DirectoryHandle) {
    this.root = root;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<LibraryState>) {
    if (this.task.signal.aborted) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  async start() {
    const task = this.task;
    const signal = task.signal;
    const current = () => !signal.aborted && task === this.task;
    this.update({ loading: true, message: "" });
    const before = this.state.manifest;
    const tags = readTags(this.root).then((result) => {
      if (!current()) return;
      if (result.status === "valid")
        this.update({
          manifest:
            this.state.manifest !== before &&
            (this.state.manifest?.revision ?? -1) > result.value.revision
              ? this.state.manifest
              : result.value,
          tagsReadable: true,
        });
      else if (this.state.manifest !== before && this.state.manifest) return;
      else if (result.status === "missing")
        this.update({ manifest: undefined, tagsReadable: true, message: "" });
      else this.update({ tagsReadable: false, message: result.message });
    });
    try {
      const catalog = await discoverCatalog(this.root, {
        signal,
        onProgress: (catalog) => {
          if (current()) this.update({ catalog });
        },
      });
      if (current()) this.update({ catalog });
      await tags;
      if (current() && this.state.selected)
        await this.select(this.state.selected);
    } catch {
      if (current())
        this.update({
          message:
            "The sample folder cannot be read. Restore folder access and try again.",
        });
    } finally {
      if (current()) this.update({ loading: false });
    }
  }
  async select(path: string) {
    const row = this.state.catalog.rows.find((sample) => sample.path === path);
    if (!row) return;
    const sequence = ++this.selection;
    this.selectionTask?.abort();
    const selectionTask = new AbortController();
    this.selectionTask = selectionTask;
    this.update({
      selected: path,
      metadata: undefined,
      metadataMessage: "Reading file format.",
    });
    try {
      const result = await validateWav(
        await row.handle.getFile(),
        selectionTask.signal,
      );
      if (sequence !== this.selection) return;
      this.update(
        result.valid
          ? { metadata: result.info, metadataMessage: "" }
          : { metadataMessage: result.reason },
      );
    } catch {
      if (sequence === this.selection)
        this.update({
          metadataMessage: "The file cannot be read. Check folder access.",
        });
    }
  }
  tags(path: string): string[] {
    return (
      this.state.drafts[path] ?? this.state.manifest?.samples[path]?.tags ?? []
    );
  }
  editTags(path: string, tags: string[]) {
    if (!this.state.tagsReadable || this.state.tagStatus[path] === "saving")
      return;
    if (!this.draftBaselines.has(path))
      this.draftBaselines.set(path, [
        ...(this.state.manifest?.samples[path]?.tags ?? []),
      ]);
    this.update({
      drafts: { ...this.state.drafts, [path]: tags },
      tagStatus: { ...this.state.tagStatus, [path]: "unsaved" },
      tagErrors: { ...this.state.tagErrors, [path]: "" },
    });
  }
  async saveTags(path: string) {
    if (!this.state.tagsReadable || this.state.tagStatus[path] === "saving")
      return;
    const task = this.task;
    const tags = this.tags(path);
    const expectedTags =
      this.draftBaselines.get(path) ??
      this.state.manifest?.samples[path]?.tags ??
      [];
    this.update({ tagStatus: { ...this.state.tagStatus, [path]: "saving" } });
    try {
      const manifest = await saveSampleTags(this.root, path, tags, {
        expectedTags,
        signal: task.signal,
      });
      if (task !== this.task || task.signal.aborted) return;
      const drafts = { ...this.state.drafts };
      delete drafts[path];
      this.draftBaselines.delete(path);
      this.update({
        manifest,
        drafts,
        tagStatus: { ...this.state.tagStatus, [path]: "saved" },
        tagErrors: { ...this.state.tagErrors, [path]: "" },
      });
    } catch (error) {
      if (task !== this.task || task.signal.aborted) return;
      this.update({
        tagStatus: { ...this.state.tagStatus, [path]: "error" },
        tagErrors: {
          ...this.state.tagErrors,
          [path]:
            error instanceof Error
              ? error.message
              : "Tags could not be saved. Retry the save.",
        },
      });
    }
  }
  async reloadSavedTags(path: string) {
    if (this.state.tagStatus[path] === "saving") return;
    this.update({ tagStatus: { ...this.state.tagStatus, [path]: "saving" } });
    const task = this.task;
    const before = this.state.manifest;
    const result = await readTags(this.root);
    if (task !== this.task || task.signal.aborted) return;
    if (result.status !== "valid" && result.status !== "missing") {
      this.update({
        tagStatus: { ...this.state.tagStatus, [path]: "error" },
        tagErrors: { ...this.state.tagErrors, [path]: result.message },
      });
      return;
    }
    const drafts = { ...this.state.drafts };
    delete drafts[path];
    this.draftBaselines.delete(path);
    this.update({
      manifest:
        this.state.manifest !== before &&
        (this.state.manifest?.revision ?? -1) >
          (result.status === "valid" ? result.value.revision : -1)
          ? this.state.manifest
          : result.status === "valid"
            ? result.value
            : undefined,
      tagsReadable: true,
      drafts,
      message: "",
      tagStatus: { ...this.state.tagStatus, [path]: "saved" },
      tagErrors: { ...this.state.tagErrors, [path]: "" },
    });
  }
  dispose() {
    this.task.abort();
    this.selectionTask?.abort();
    this.selection++;
    this.listeners.clear();
  }
  suspend() {
    this.update({
      loading: false,
      tagsReadable: false,
      metadata: undefined,
      metadataMessage:
        "Source details will refresh after folder access returns.",
      tagStatus: Object.fromEntries(
        Object.entries(this.state.tagStatus).map(([path, status]) => [
          path,
          status === "saving" ? "unsaved" : status,
        ]),
      ),
    });
    this.task.abort();
    this.selectionTask?.abort();
    this.selection++;
  }
  resume(root: DirectoryHandle) {
    this.suspend();
    this.root = root;
    this.task = new AbortController();
  }
}
