import type { DirectoryHandle } from "../storage/handles.ts";
import { validateWav, type WavInfo } from "../domain/wav.ts";
import { analyzeSource } from "../audio/analyzer.ts";
import type { AudioAnalysisReply } from "../audio/analyze-worker.ts";
import { analyzePair } from "../audio/pair-analyzer.ts";
import type { PairAudioReply } from "../audio/pair-worker.ts";
import { MAX_DECODE_WAV_BYTES, MAX_DECODE_WAV_SECONDS } from "../audio/pcm.ts";
import { planPreparation, type PlanResult } from "../domain/preparation.ts";
import type { FileHandle } from "../storage/handles.ts";
import { discoverCatalog, type CatalogResult } from "./catalog.ts";
import {
  PreparationQueue,
  type PreparationOptions,
  type PreparationState,
} from "./preparation.ts";
import { saveAudioAnalysis } from "./audio-manifest.ts";
import { savePairAnalysis } from "./pair-manifest.ts";
import { verifyOfficialSource } from "./source-manifest.ts";
import { readTags, saveSampleTags, type TagManifest } from "./tags.ts";

export interface SourceAnalysisState {
  path: string;
  status:
    | "checking"
    | "ready"
    | "needs-conversion"
    | "needs-review"
    | "unusable"
    | "error";
  message: string;
  result?: AudioAnalysisReply;
  plan?: PlanResult;
}

export interface PairDraft {
  leftPath: string | null;
  rightPath: string | null;
  provenanceId: string | null;
}

export interface PairCheckState {
  status: "checking" | "ready" | "needs-conversion" | "needs-review" | "error";
  message: string;
  result?: PairAudioReply;
}

export interface LibraryState {
  catalog: CatalogResult;
  manifest?: TagManifest;
  selected: string | null;
  drafts: Record<string, string[]>;
  tagStatus: Record<string, "unsaved" | "saving" | "saved" | "error">;
  tagErrors: Record<string, string>;
  metadata?: WavInfo;
  metadataMessage: string;
  analysis?: SourceAnalysisState;
  pairDraft: PairDraft;
  pair?: PairCheckState;
  preparation: PreparationState;
  preparationError: string;
  message: string;
  loading: boolean;
  tagsReadable: boolean;
}

export class LibraryController {
  private root: DirectoryHandle;
  private task = new AbortController();
  private selection = 0;
  private selectionTask?: AbortController;
  private pairSelection = 0;
  private pairTask?: AbortController;
  private draftBaselines = new Map<string, string[]>();
  private analyzedSources = new Map<string, string | null>();
  private preparation: PreparationQueue;
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
    pairDraft: { leftPath: null, rightPath: null, provenanceId: null },
    preparation: {
      jobs: {},
      progress: {},
      readable: false,
      recoveryRequired: false,
      message: "",
      session: "",
    },
    preparationError: "",
    message: "",
    loading: true,
    tagsReadable: false,
  };
  constructor(
    root: DirectoryHandle,
    preparation: Omit<PreparationOptions, "onOutput"> = {},
  ) {
    this.root = root;
    this.preparation = new PreparationQueue(root, {
      ...preparation,
      onOutput: (path, handle) => this.addRow(path, handle),
    });
    this.preparation.subscribe(() =>
      this.update({ preparation: this.preparation.getSnapshot() }),
    );
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
    this.update({
      loading: true,
      message: "",
      metadata: undefined,
      metadataMessage: this.state.selected ? "Reading file format." : "",
      analysis: undefined,
      pair: undefined,
    });
    const before = this.state.manifest;
    void this.preparation.load().catch(() => undefined);
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
    this.analyzedSources.set(path, null);
    this.update({
      selected: path,
      metadata: undefined,
      metadataMessage: "Reading file format.",
      analysis: {
        path,
        status: "checking",
        message: "Checking source audio.",
      },
    });
    try {
      const file = await row.handle.getFile();
      if (sequence !== this.selection || selectionTask.signal.aborted) return;
      if (file.size > MAX_DECODE_WAV_BYTES) {
        const message =
          "Analysis supports files up to 100 MiB. This source needs review.";
        this.update({
          metadataMessage: message,
          analysis: { path, status: "needs-review", message },
        });
        return;
      }
      const result = await validateWav(file, selectionTask.signal);
      if (sequence !== this.selection) return;
      if (!result.valid) {
        this.update({
          metadataMessage: result.reason,
          analysis: { path, status: "unusable", message: result.reason },
        });
        return;
      }
      this.update({
        metadata: result.info,
        metadataMessage: "",
        analysis: {
          path,
          status: "checking",
          message: "Analyzing source audio.",
        },
      });
      if (result.info.duration > MAX_DECODE_WAV_SECONDS) {
        this.update({
          analysis: {
            path,
            status: "needs-review",
            message:
              "Analysis supports sources up to five minutes. This source needs review.",
          },
        });
        return;
      }
      const source = await verifyOfficialSource(
        this.root,
        path,
        selectionTask.signal,
      );
      if (sequence !== this.selection || selectionTask.signal.aborted) return;
      const prepared = this.preparation.readyOutput(path);
      const analyzed = await analyzeSource(
        file,
        selectionTask.signal,
        source.verifiedOfficialSource
          ? {
              sourceSha256: source.sourceSha256,
              sourceBytes: source.sourceBytes,
            }
          : undefined,
        prepared?.output
          ? {
              sha256: prepared.output.sha256,
              bytes: prepared.output.bytes,
              expectedBpm: prepared.plan.targetBpm,
            }
          : undefined,
      );
      if (sequence !== this.selection || selectionTask.signal.aborted) return;
      try {
        this.analyzedSources.set(path, analyzed.sourceSha256);
        await saveAudioAnalysis(
          this.root,
          path,
          analyzed,
          selectionTask.signal,
        );
      } catch {
        if (sequence !== this.selection || selectionTask.signal.aborted) return;
        this.update({
          analysis: {
            path,
            status: "error",
            message:
              "Analysis finished, but its record could not be saved. Check folder access and try again.",
            result: analyzed,
          },
        });
        return;
      }
      if (sequence !== this.selection || selectionTask.signal.aborted) return;
      this.update({
        analysis: {
          path,
          status: analyzed.analysis.status,
          message: analyzed.analysis.reasons.join(" "),
          result: analyzed,
          plan: planPreparation(analyzed.analysis, analyzed.info),
        },
        preparationError: "",
      });
    } catch (error) {
      if (selectionTask.signal.aborted) return;
      if (sequence === this.selection)
        this.update({
          metadataMessage: this.state.metadata
            ? ""
            : "The file cannot be read. Check folder access.",
          analysis: {
            path,
            status: "error",
            message:
              error instanceof Error &&
              error.message === "Audio analysis is unavailable in this browser."
                ? error.message
                : "The source audio could not be analyzed. Check folder access and try again.",
          },
        });
    }
  }
  /** Save a job for the analyzed selection. Processing continues in the background. */
  async prepare() {
    const analysis = this.state.analysis;
    if (!analysis?.result || analysis.status !== "needs-conversion") return;
    await this.preparationCommand(() =>
      this.preparation.prepare(analysis.path, analysis.result!),
    );
  }
  cancelPreparation(id: string) {
    return this.preparationCommand(() => this.preparation.cancel(id));
  }
  retryPreparation(id: string) {
    return this.preparationCommand(() => this.preparation.retry(id));
  }
  recoverPreparation() {
    return this.preparationCommand(() => this.preparation.recoverPersistence());
  }
  private async preparationCommand(command: () => Promise<unknown>) {
    this.update({ preparationError: "" });
    try {
      await command();
    } catch (error) {
      this.update({
        preparationError:
          error instanceof Error
            ? error.message
            : "The preparation command failed. Try again.",
      });
    }
  }
  /** Give source preview priority over preparation work. */
  setPlaybackActive(active: boolean) {
    this.preparation.setPlaybackActive(active);
  }
  /** The newest job for the current source content. */
  preparationFor(path: string, sourceSha256?: string) {
    const hash = sourceSha256 ?? this.analyzedSources.get(path);
    if (hash === null) return undefined;
    return this.preparation.jobFor(path, hash);
  }
  private addRow(path: string, handle: FileHandle) {
    if (this.state.catalog.rows.some((row) => row.path === path)) return;
    const parts = path.split("/");
    const folders = new Set(this.state.catalog.folders);
    for (let index = 1; index < parts.length; index++)
      folders.add(parts.slice(0, index).join("/"));
    this.update({
      catalog: {
        ...this.state.catalog,
        rows: [
          ...this.state.catalog.rows,
          {
            id: path,
            path,
            name: parts.at(-1)!,
            folder: parts.slice(0, -1).join("/"),
            handle,
            format: "WAV" as const,
            preparation: "not-prepared" as const,
          },
        ].sort((a, b) => a.path.localeCompare(b.path)),
        folders: [...folders].sort((a, b) => a.localeCompare(b)),
        examined: this.state.catalog.examined + 1,
      },
    });
  }
  setPairSide(side: "left" | "right", path: string) {
    if (!this.state.catalog.rows.some((sample) => sample.path === path)) return;
    const other =
      side === "left"
        ? this.state.pairDraft.rightPath
        : this.state.pairDraft.leftPath;
    if (other === path) {
      this.update({
        pair: {
          status: "error",
          message: "Select different files for the left and right channels.",
        },
      });
      return;
    }
    this.pairTask?.abort();
    this.pairSelection++;
    this.update({
      pairDraft: {
        ...this.state.pairDraft,
        ...(side === "left" ? { leftPath: path } : { rightPath: path }),
        provenanceId: crypto.randomUUID(),
      },
      pair: undefined,
    });
  }
  clearPair() {
    this.pairTask?.abort();
    this.pairSelection++;
    this.update({
      pairDraft: { leftPath: null, rightPath: null, provenanceId: null },
      pair: undefined,
    });
  }
  async checkPair() {
    const { leftPath, rightPath, provenanceId } = this.state.pairDraft;
    const left = this.state.catalog.rows.find((row) => row.path === leftPath);
    const right = this.state.catalog.rows.find((row) => row.path === rightPath);
    if (!left || !right || !provenanceId || left.path === right.path) {
      this.update({
        pair: {
          status: "error",
          message: "Select different left and right source files first.",
        },
      });
      return;
    }
    const sequence = ++this.pairSelection;
    this.pairTask?.abort();
    const task = new AbortController();
    this.pairTask = task;
    this.update({
      pair: {
        status: "checking",
        message: "Checking source pairing and audio.",
      },
    });
    try {
      const [leftFile, rightFile] = await Promise.all([
        left.handle.getFile(),
        right.handle.getFile(),
      ]);
      if (sequence !== this.pairSelection || task.signal.aborted) return;
      if (
        leftFile.size > MAX_DECODE_WAV_BYTES ||
        rightFile.size > MAX_DECODE_WAV_BYTES ||
        leftFile.size + rightFile.size > MAX_DECODE_WAV_BYTES
      ) {
        this.update({
          pair: {
            status: "needs-review",
            message:
              "Stereo analysis supports up to 100 MiB across both source files.",
          },
        });
        return;
      }
      const [leftSource, rightSource] = await Promise.all([
        verifyOfficialSource(this.root, left.path, task.signal),
        verifyOfficialSource(this.root, right.path, task.signal),
      ]);
      if (sequence !== this.pairSelection || task.signal.aborted) return;
      const result = await analyzePair(
        { path: left.path, file: leftFile },
        { path: right.path, file: rightFile },
        provenanceId,
        task.signal,
        leftSource.verifiedOfficialSource && rightSource.verifiedOfficialSource
          ? {
              left: {
                sourceSha256: leftSource.sourceSha256,
                sourceBytes: leftSource.sourceBytes,
              },
              right: {
                sourceSha256: rightSource.sourceSha256,
                sourceBytes: rightSource.sourceBytes,
              },
            }
          : undefined,
      );
      if (sequence !== this.pairSelection || task.signal.aborted) return;
      if (!result.valid) {
        this.update({
          pair: { status: "needs-review", message: result.reason, result },
        });
        return;
      }
      if (
        result.analysis.status === "ready" &&
        result.analysis.measured.sampleKind.startsWith("source-backed-")
      ) {
        this.update({
          pair: {
            status: "needs-review",
            message:
              "This pair needs a measured channel result before it can be ready.",
            result,
          },
        });
        return;
      }
      await savePairAnalysis(this.root, result, task.signal);
      if (sequence !== this.pairSelection || task.signal.aborted) return;
      this.update({
        pair: {
          status: result.analysis.status,
          message: result.analysis.reasons.join(" "),
          result,
        },
      });
    } catch (error) {
      if (sequence !== this.pairSelection || task.signal.aborted) return;
      this.update({
        pair: {
          status: "error",
          message:
            error instanceof Error &&
            error.message === "Stereo analysis is unavailable in this browser."
              ? error.message
              : "The stereo pair could not be checked or saved. Check folder access and try again.",
        },
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
    this.preparation.dispose();
    this.selectionTask?.abort();
    this.pairTask?.abort();
    this.selection++;
    this.pairSelection++;
    this.listeners.clear();
  }
  suspend() {
    this.update({
      loading: false,
      tagsReadable: false,
      metadata: undefined,
      analysis: undefined,
      pair: undefined,
      metadataMessage:
        "Source details will refresh after folder access returns.",
      tagStatus: Object.fromEntries(
        Object.entries(this.state.tagStatus).map(([path, status]) => [
          path,
          status === "saving" ? "unsaved" : status,
        ]),
      ),
    });
    this.preparation.suspend();
    this.task.abort();
    this.selectionTask?.abort();
    this.pairTask?.abort();
    this.selection++;
    this.pairSelection++;
  }
  resume(root: DirectoryHandle) {
    this.suspend();
    this.root = root;
    this.task = new AbortController();
    this.preparation.resume(root);
  }
}
