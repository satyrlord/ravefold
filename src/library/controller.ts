import type { DirectoryHandle } from "../storage/handles.ts";
import { validateWav, type WavInfo } from "../domain/wav.ts";
import {
  analyzeSource,
  type PreparedOutputEvidence,
} from "../audio/analyzer.ts";
import type { AudioAnalysis } from "../audio/analyze.ts";
import type { AudioAnalysisReply } from "../audio/analyze-worker.ts";
import { analyzePair } from "../audio/pair-analyzer.ts";
import type { PairAudioReply } from "../audio/pair-worker.ts";
import { MAX_DECODE_WAV_BYTES, MAX_DECODE_WAV_SECONDS } from "../audio/pcm.ts";
import {
  outputContext,
  planPreparation,
  type PlanInput,
  type PlanResult,
} from "../domain/preparation.ts";
import type { FileHandle } from "../storage/handles.ts";
import { discoverCatalog, type CatalogResult } from "./catalog.ts";
import {
  PreparationQueue,
  type PreparationOptions,
  type PreparationState,
} from "./preparation.ts";
import {
  readAudioAnalysis,
  saveAudioAnalysis,
  type AudioRecord,
} from "./audio-manifest.ts";
import { savePairAnalysis } from "./pair-manifest.ts";
import { verifyOfficialSource } from "./source-manifest.ts";
import {
  correctedAudio,
  isEmptyReview,
  planCorrection,
  reviewInput,
  reviewInputProblem,
  reviewRequest,
  type ReviewInput,
} from "./review.ts";
import { readTags, saveSampleTags, type TagManifest } from "./tags.ts";

/** The analysis entry point. Tests can run it without a Worker. */
export type SourceAnalyzer = typeof analyzeSource;

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
  /** The corrected analysis for a whole-source review. */
  planInput?: PlanInput & { analysis: AudioAnalysis };
}

/** The validation result for the review input of one source. */
export interface ReviewState {
  path: string;
  sourceSha256: string;
  status:
    | "checking"
    | "ready"
    | "needs-conversion"
    | "needs-review"
    | "invalid"
    | "error";
  message: string;
  /** The input that this result validated. */
  input: ReviewInput;
  reviewed?: AudioAnalysis;
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
  review?: ReviewState;
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
  private reviewSequence = 0;
  private reviewTask?: AbortController;
  private readonly analyze: SourceAnalyzer;
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
    options: Omit<PreparationOptions, "onOutput"> & {
      analyze?: SourceAnalyzer;
    } = {},
  ) {
    const { analyze, ...preparation } = options;
    this.analyze = analyze ?? analyzeSource;
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
      review: undefined,
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
    this.reviewTask?.abort();
    this.reviewSequence++;
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
      review: undefined,
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
      // A saved review applies again only to the same source content.
      const stored = await this.storedRecord(path);
      if (sequence !== this.selection || selectionTask.signal.aborted) return;
      const storedInput =
        stored?.corrected &&
        stored.sourceBytes === file.size &&
        JSON.stringify(stored.wav) === JSON.stringify(result.info)
          ? reviewInput(stored.corrected)
          : undefined;
      const review =
        storedInput && !isEmptyReview(storedInput) ? storedInput : undefined;
      const reply = await this.analyze(
        file,
        selectionTask.signal,
        source.verifiedOfficialSource
          ? {
              sourceSha256: source.sourceSha256,
              sourceBytes: source.sourceBytes,
            }
          : undefined,
        this.preparedEvidence(path),
        review ? reviewRequest(review) : undefined,
      );
      if (sequence !== this.selection || selectionTask.signal.aborted) return;
      const kept =
        review && reply.reviewed && reply.sourceSha256 === stored?.sourceSha256
          ? review
          : undefined;
      const analyzed: AudioAnalysisReply = { ...reply };
      if (!kept) delete analyzed.reviewed;
      try {
        this.analyzedSources.set(path, analyzed.sourceSha256);
        await saveAudioAnalysis(
          this.root,
          path,
          { ...analyzed, corrected: kept ? correctedAudio(kept) : null },
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
      this.applyReply(path, analyzed, kept);
      this.update({ preparationError: "" });
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
  private async storedRecord(path: string): Promise<AudioRecord | undefined> {
    try {
      const read = await readAudioAnalysis(this.root);
      return read.status === "valid" ? read.value.samples[path] : undefined;
    } catch {
      return undefined;
    }
  }

  /** Evidence for a file that a ready job produced. */
  private preparedEvidence(path: string): PreparedOutputEvidence | undefined {
    const prepared = this.preparation.readyOutput(path);
    if (!prepared?.output) return undefined;
    const target = prepared.plan.targetBpm;
    return {
      sha256: prepared.output.sha256,
      bytes: prepared.output.bytes,
      expectedBpm: target,
      ...(outputContext(prepared.plan).correction
        ? { correctedBpm: target }
        : {}),
    };
  }

  /**
   * Show a reply. A whole-source review sets the source status. A region
   * review never changes the source status.
   */
  private applyReply(
    path: string,
    reply: AudioAnalysisReply,
    input: ReviewInput | undefined,
  ) {
    const reviewed = input ? reply.reviewed : undefined;
    const correction = input ? planCorrection(input) : null;
    const whole = reviewed && !input!.region ? reviewed : undefined;
    const planInput = whole ? { analysis: whole, correction } : undefined;
    const effective = whole ?? reply.analysis;
    this.update({
      analysis: {
        path,
        status: effective.status,
        message: effective.reasons.join(" "),
        result: reply,
        plan: planPreparation(effective, reply.info, planInput ?? {}),
        ...(planInput ? { planInput } : {}),
      },
      review:
        input && reviewed
          ? {
              path,
              sourceSha256: reply.sourceSha256,
              status: reviewed.status,
              message: reviewed.reasons.join(" "),
              input,
              reviewed,
              plan: planPreparation(reviewed, reply.info, {
                region: input.region,
                correction,
              }),
            }
          : undefined,
    });
  }

  /**
   * Validate corrected input again. Empty input removes the saved correction.
   * A later request or selection makes an earlier result stale.
   */
  async submitReview(input: ReviewInput) {
    const path = this.state.selected;
    const analysis = this.state.analysis;
    const row = this.state.catalog.rows.find((sample) => sample.path === path);
    if (!path || !row || analysis?.path !== path || !analysis.result) return;
    const selection = this.selection;
    const sequence = ++this.reviewSequence;
    this.reviewTask?.abort();
    const task = new AbortController();
    this.reviewTask = task;
    const base = {
      path,
      sourceSha256: analysis.result.sourceSha256,
      input,
    };
    const problem = reviewInputProblem(input, analysis.result.info);
    if (problem) {
      this.update({
        review: { ...base, status: "invalid", message: problem },
      });
      return;
    }
    const empty = isEmptyReview(input);
    this.update({
      review: {
        ...base,
        status: "checking",
        message: empty
          ? "Removing the corrections and checking the source again."
          : "Validating the corrected input.",
      },
    });
    const stale = () =>
      sequence !== this.reviewSequence ||
      selection !== this.selection ||
      task.signal.aborted;
    try {
      const file = await row.handle.getFile();
      if (stale()) return;
      const source = await verifyOfficialSource(this.root, path, task.signal);
      if (stale()) return;
      const reply = await this.analyze(
        file,
        task.signal,
        source.verifiedOfficialSource
          ? {
              sourceSha256: source.sourceSha256,
              sourceBytes: source.sourceBytes,
            }
          : undefined,
        this.preparedEvidence(path),
        empty ? undefined : reviewRequest(input),
      );
      if (stale()) return;
      this.analyzedSources.set(path, reply.sourceSha256);
      await saveAudioAnalysis(
        this.root,
        path,
        { ...reply, corrected: empty ? null : correctedAudio(input) },
        task.signal,
      );
      if (stale()) return;
      this.applyReply(path, reply, empty ? undefined : input);
    } catch (error) {
      if (stale()) return;
      this.update({
        review: {
          ...base,
          status: "error",
          message:
            error instanceof Error &&
            (error.message.startsWith("The region") ||
              error.message ===
                "Audio analysis is unavailable in this browser.")
              ? error.message
              : "The review could not be validated or saved. Check folder access and try again.",
        },
      });
    }
  }

  /** Save a job for the analyzed selection. Processing continues in the background. */
  async prepare() {
    const analysis = this.state.analysis;
    if (!analysis?.result || analysis.status !== "needs-conversion") return;
    await this.preparationCommand(() =>
      this.preparation.prepare(
        analysis.path,
        analysis.result!,
        analysis.planInput,
      ),
    );
  }

  /** Save a job for the validated review section. */
  async prepareReview() {
    const review = this.state.review;
    const analysis = this.state.analysis;
    if (
      !review?.reviewed ||
      !review.plan?.valid ||
      !review.input.region ||
      !analysis?.result ||
      review.path !== analysis.path ||
      review.sourceSha256 !== analysis.result.sourceSha256
    )
      return;
    const reviewed = review.reviewed;
    await this.preparationCommand(() =>
      this.preparation.prepare(review.path, analysis.result!, {
        analysis: reviewed,
        region: review.input.region,
        correction: planCorrection(review.input),
      }),
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
  /** The newest job of any kind for the current source content. */
  preparationFor(path: string, sourceSha256?: string) {
    const hash = sourceSha256 ?? this.analyzedSources.get(path);
    if (hash === null) return undefined;
    return this.preparation.jobFor(path, hash);
  }
  /** The job for the complete-source plan of the current analysis. */
  wholePreparation(path: string, sourceSha256?: string) {
    const hash = sourceSha256 ?? this.analyzedSources.get(path);
    if (hash === null) return undefined;
    const plan = this.state.analysis?.plan;
    if (hash && this.state.analysis?.path === path && plan?.valid)
      return this.preparation.jobForPlan(hash, plan.plan);
    return this.preparation.jobFor(path, hash, true);
  }
  /** The job that the current review input produced. */
  reviewPreparation() {
    const review = this.state.review;
    if (!review?.plan?.valid || !review.input.region) return undefined;
    return this.preparation.jobForPlan(review.sourceSha256, review.plan.plan);
  }
  /** Section jobs for the current source content, newest first. */
  sectionPreparations(path: string, sourceSha256: string) {
    return this.preparation
      .jobsFor(path, sourceSha256)
      .filter((job) => job.plan.region !== null);
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
    this.reviewTask?.abort();
    this.reviewSequence++;
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
      review: undefined,
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
    this.reviewTask?.abort();
    this.reviewSequence++;
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
