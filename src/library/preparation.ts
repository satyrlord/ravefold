import type { AudioAnalysisReply } from "../audio/analyze-worker.ts";
import type { PreparationStage } from "../audio/prepare-core.ts";
import { workerRunner, type PreparationRunner } from "../audio/preparer.ts";
import {
  ACTIVE_PHASES,
  planPreparation,
  preparationJobId,
  preparedOutputPath,
  PREPARATION_PROCESSOR,
  type PreparationJob,
  type PreparationPhase,
} from "../domain/preparation.ts";
import { validateWav } from "../domain/wav.ts";
import {
  checkAbort,
  isAccessDenied,
  isCancellation,
  isNamedError,
  type DirectoryHandle,
  type FileHandle,
} from "../storage/handles.ts";
import { saveAudioAnalysis } from "./audio-manifest.ts";
import {
  readPreparation,
  updatePreparation,
  type PreparationChange,
} from "./preparation-manifest.ts";

export interface PreparationState {
  jobs: Record<string, PreparationJob>;
  /** Progress in [0, 1] inside the current phase, for jobs in this session. */
  progress: Record<string, number>;
  readable: boolean;
  /** Local work stopped because its durable state could not be saved. */
  recoveryRequired: boolean;
  message: string;
  /** This session's lease owner ID. */
  session: string;
}

export interface PreparationOptions {
  runner?: PreparationRunner;
  now?: () => number;
  leaseMs?: number;
  onOutput?: (path: string, handle: FileHandle) => void;
}

const MAX_OUTPUT_INDEX = 100;

class Superseded extends Error {
  constructor() {
    super("Another action changed this preparation job.");
  }
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function folderFor(
  root: DirectoryHandle,
  path: string,
  create: boolean,
): Promise<{ folder: DirectoryHandle; name: string }> {
  const parts = path.split("/");
  let folder = root;
  for (const part of parts.slice(0, -1))
    folder = await folder.getDirectoryHandle(part, create ? { create } : {});
  return { folder, name: parts.at(-1)! };
}

async function exists(root: DirectoryHandle, path: string): Promise<boolean> {
  try {
    const { folder, name } = await folderFor(root, path, false);
    await folder.getFileHandle(name);
    return true;
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) return false;
    throw error;
  }
}

export async function sourceHandle(
  root: DirectoryHandle,
  path: string,
): Promise<FileHandle> {
  const { folder, name } = await folderFor(root, path, false);
  return folder.getFileHandle(name);
}

/** Write a new file. An existing file at the path is an error, not a target. */
async function writeNewFile(
  root: DirectoryHandle,
  path: string,
  bytes: ArrayBuffer,
  signal: AbortSignal,
): Promise<FileHandle> {
  const { folder, name } = await folderFor(root, path, true);
  try {
    await folder.getFileHandle(name);
    throw new Error("The output path already has a file.");
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
  }
  checkAbort(signal);
  const handle = await folder.getFileHandle(name, { create: true });
  if ((await handle.getFile()).size !== 0)
    throw new Error("The output path changed before the write.");
  const writer = await handle.createWritable({ mode: "exclusive" });
  let closed = false;
  try {
    await writer.write(bytes, signal);
    checkAbort(signal);
    await writer.close();
    closed = true;
    return handle;
  } finally {
    // An aborted writer keeps the created file. Partial audio stays on disk.
    if (!closed) await writer.abort().catch(() => undefined);
  }
}

function failureMessage(error: unknown): string {
  if (isNamedError(error, "QuotaExceededError"))
    return "The disk has insufficient space. Make space available, then retry.";
  if (isAccessDenied(error))
    return "Folder access was lost. Restore access, then retry.";
  return error instanceof Error && error.message
    ? error.message
    : "The sample could not be prepared. Retry the job.";
}

/** Keep one path list per job. Earlier audio paths are never reused. */
function keepOutput(job: PreparationJob): string[] {
  return job.outputPath
    ? [...job.keptOutputs, job.outputPath]
    : job.keptOutputs;
}

export class PreparationQueue {
  private root: DirectoryHandle;
  private readonly runner: PreparationRunner;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly onOutput: PreparationOptions["onOutput"];
  private readonly session = crypto.randomUUID();
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private running?: { id: string; abort: AbortController };
  private cancelled = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idle: Promise<void> = Promise.resolve();
  private state: PreparationState = {
    jobs: {},
    progress: {},
    readable: false,
    recoveryRequired: false,
    message: "",
    session: this.session,
  };

  constructor(root: DirectoryHandle, options: PreparationOptions = {}) {
    this.root = root;
    this.runner = options.runner ?? workerRunner();
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.onOutput = options.onOutput;
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Resolve after the current job and any jobs that it starts. */
  async whenIdle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.idle;
      await current;
    } while (current !== this.idle);
  }

  private publish(patch: Partial<PreparationState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private setProgress(id: string, value: number | undefined) {
    const progress = { ...this.state.progress };
    if (value === undefined) delete progress[id];
    else progress[id] = value;
    this.publish({ progress });
  }

  private async change(change: PreparationChange): Promise<void> {
    try {
      const manifest = await updatePreparation(
        this.root,
        change,
        this.lifetime.signal,
      );
      this.publish({ jobs: manifest.jobs });
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.stopForRecovery(error);
      throw error;
    }
  }

  private stopForRecovery(error: unknown): void {
    this.running?.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.publish({
      readable: false,
      recoveryRequired: true,
      message: failureMessage(error),
      progress: {},
    });
  }

  /** Change one job only while this session holds its lease. */
  private async own(
    id: string,
    patch: (job: PreparationJob) => Partial<PreparationJob>,
  ): Promise<void> {
    let owned = false;
    await this.change((jobs) => {
      const job = jobs[id];
      if (
        !job ||
        !ACTIVE_PHASES.includes(job.phase) ||
        job.lease?.session !== this.session
      )
        return undefined;
      owned = true;
      return {
        ...jobs,
        [id]: { ...job, ...patch(job), updatedAt: this.now() },
      };
    });
    if (!owned) throw new Superseded();
  }

  private lease() {
    return { session: this.session, expiresAt: this.now() + this.leaseMs };
  }

  /** Requeue interrupted work. Its earlier output path stays reserved. */
  private recoverChange: PreparationChange = (jobs) => {
    let changed = false;
    const next = { ...jobs };
    for (const [id, job] of Object.entries(jobs)) {
      if (!job.lease || !ACTIVE_PHASES.includes(job.phase)) continue;
      const own = job.lease.session === this.session;
      if (own ? this.running?.id === id : job.lease.expiresAt > this.now())
        continue;
      changed = true;
      next[id] = {
        ...job,
        phase: "queued",
        attempt: job.attempt + 1,
        outputPath: null,
        keptOutputs: keepOutput(job),
        lease: null,
        message:
          "Preparation was interrupted. It restarts with a new output path.",
        updatedAt: this.now(),
      };
    }
    return changed ? next : undefined;
  };

  async load(): Promise<void> {
    const read = await readPreparation(this.root);
    if (this.lifetime.signal.aborted) return;
    if (read.status === "valid")
      this.publish({
        jobs: read.value.jobs,
        readable: true,
        recoveryRequired: false,
        message: "",
      });
    else if (read.status === "missing")
      this.publish({
        jobs: {},
        readable: true,
        recoveryRequired: false,
        message: "",
      });
    else {
      this.stopForRecovery(new Error(read.message));
      return;
    }
    await this.recover();
  }

  /** Reload durable state after the user restores storage access or space. */
  async recoverPersistence(): Promise<void> {
    await this.whenIdle();
    await this.load();
  }

  /** Check again when another session's lease can expire. */
  private watchLeases(): void {
    if (
      this.timer ||
      this.lifetime.signal.aborted ||
      this.state.recoveryRequired
    )
      return;
    const expiries = Object.values(this.state.jobs)
      .filter((job) => job.lease && job.lease.session !== this.session)
      .map((job) => job.lease!.expiresAt);
    if (!expiries.length) return;
    const delay = Math.max(0, Math.min(...expiries) - this.now()) + 250;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.recover();
    }, delay);
  }

  private async recover(): Promise<void> {
    try {
      // Take the shared reservation only when a stored job needs recovery.
      if (this.recoverChange(this.state.jobs))
        await this.change(this.recoverChange);
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.stopForRecovery(error);
      return;
    }
    this.schedule();
    this.watchLeases();
  }

  /** The newest job for source content, or for a path without a known hash. */
  jobFor(path: string, sourceSha256?: string): PreparationJob | undefined {
    return Object.values(this.state.jobs)
      .filter((job) =>
        sourceSha256
          ? job.source.sourceSha256 === sourceSha256
          : job.source.path === path,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  /** A ready job that produced the file at this path. */
  readyOutput(path: string): PreparationJob | undefined {
    return Object.values(this.state.jobs).find(
      (job) => job.phase === "ready" && job.output?.path === path,
    );
  }

  /** Save the job before any processing starts. Equal jobs are not repeated. */
  async prepare(path: string, reply: AudioAnalysisReply): Promise<string> {
    const planned = planPreparation(reply.analysis, reply.info);
    if (!planned.valid) throw new Error(planned.reason);
    const id = await preparationJobId(reply.sourceSha256, planned.plan);
    await this.change((jobs) => {
      if (jobs[id]) return undefined;
      return {
        ...jobs,
        [id]: {
          id,
          source: {
            path,
            sourceSha256: reply.sourceSha256,
            sourceBytes: reply.sourceBytes,
            wav: reply.info,
          },
          plan: planned.plan,
          processor: PREPARATION_PROCESSOR,
          phase: "queued",
          attempt: 1,
          outputPath: null,
          keptOutputs: [],
          lease: null,
          output: null,
          message: "Waiting for preparation.",
          updatedAt: this.now(),
        },
      };
    });
    this.schedule();
    return id;
  }

  async retry(id: string): Promise<void> {
    await this.change((jobs) => {
      const job = jobs[id];
      if (!job || (job.phase !== "failed" && job.phase !== "cancelled"))
        return undefined;
      return {
        ...jobs,
        [id]: {
          ...job,
          phase: "queued",
          attempt: job.attempt + 1,
          outputPath: null,
          keptOutputs: keepOutput(job),
          message: "Waiting for preparation. A new output path is used.",
          updatedAt: this.now(),
        },
      };
    });
    this.schedule();
  }

  /** Stop the work. A late result cannot change a cancelled job. */
  async cancel(id: string): Promise<void> {
    this.cancelled.add(id);
    if (this.running?.id === id) this.running.abort.abort();
    await this.change((jobs) => {
      const job = jobs[id];
      if (
        !job ||
        (job.phase !== "queued" && !ACTIVE_PHASES.includes(job.phase))
      )
        return undefined;
      return {
        ...jobs,
        [id]: {
          ...job,
          phase: "cancelled",
          lease: null,
          message:
            "Preparation was cancelled. Existing and partial audio stay unchanged.",
          updatedAt: this.now(),
        },
      };
    });
  }

  setPlaybackActive(active: boolean): void {
    this.runner.setPaused(active);
  }

  private schedule(): void {
    if (this.running || !this.state.readable || this.lifetime.signal.aborted)
      return;
    const next = Object.values(this.state.jobs)
      .filter((job) => job.phase === "queued")
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!next) return;
    const abort = new AbortController();
    this.running = { id: next.id, abort };
    this.cancelled.delete(next.id);
    this.idle = this.run(next.id, abort).finally(() => {
      if (this.running?.abort === abort) this.running = undefined;
      this.setProgress(next.id, undefined);
      this.schedule();
      this.watchLeases();
    });
  }

  private async choosePath(job: PreparationJob): Promise<string> {
    const reserved = new Set(
      Object.values(this.state.jobs).flatMap((item) =>
        [item.outputPath, ...item.keptOutputs]
          .filter((path): path is string => path !== null)
          .map((path) => path.toLowerCase()),
      ),
    );
    for (let index = 1; index <= MAX_OUTPUT_INDEX; index++) {
      const path = preparedOutputPath(job.source.path, job.plan, index);
      if (reserved.has(path.toLowerCase())) continue;
      if (!(await exists(this.root, path))) return path;
    }
    throw new Error("No unused output path is available for this sample.");
  }

  private async run(id: string, abort: AbortController): Promise<void> {
    const signal = abort.signal;
    const live = () => !signal.aborted && this.running?.abort === abort;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let phase: PreparationPhase = "analysis";
    let phaseWrite: Promise<void> = Promise.resolve();
    try {
      let claimed = false;
      await this.change((jobs) => {
        const job = jobs[id];
        if (!job || job.phase !== "queued") return undefined;
        claimed = true;
        return {
          ...jobs,
          [id]: {
            ...job,
            phase: "analysis",
            lease: this.lease(),
            message: "Checking the source audio.",
            updatedAt: this.now(),
          },
        };
      });
      if (!claimed) throw new Superseded();
      renewal = setInterval(() => {
        phaseWrite = phaseWrite
          .then(() => this.own(id, () => ({ lease: this.lease() })))
          .catch(() => undefined);
      }, this.leaseMs / 3);
      const job = this.state.jobs[id]!;
      const file = await (
        await sourceHandle(this.root, job.source.path)
      ).getFile();
      if (file.size !== job.source.sourceBytes)
        throw new Error("The source changed after the job was saved.");
      const outcome = await this.runner.run(
        { file, sourceSha256: job.source.sourceSha256, plan: job.plan },
        {
          signal,
          onProgress: (stage: PreparationStage, fraction: number) => {
            if (!live()) return;
            this.setProgress(id, fraction);
            if (stage === phase) return;
            phase = stage;
            const message =
              stage === "conversion"
                ? "Converting tempo and pitch."
                : "Validating the new audio.";
            phaseWrite = phaseWrite
              .then(() => this.own(id, () => ({ phase: stage, message })))
              .catch(() => undefined);
          },
        },
      );
      await phaseWrite;
      if (!live()) return;
      if (outcome.status === "review") {
        await this.own(id, () => ({
          phase: "review",
          lease: null,
          message: outcome.reasons.join(" "),
        }));
        return;
      }
      const path = await this.choosePath(this.state.jobs[id]!);
      await this.own(id, () => ({
        phase: "validation",
        outputPath: path,
        message: "Writing the validated audio to a new file.",
      }));
      const handle = await writeNewFile(this.root, path, outcome.bytes, signal);
      const written = await handle.getFile();
      checkAbort(signal);
      const check = await validateWav(written, signal);
      if (
        written.size !== outcome.bytes.byteLength ||
        !check.valid ||
        JSON.stringify(check.info) !== JSON.stringify(outcome.info) ||
        hex(
          await crypto.subtle.digest("SHA-256", await written.arrayBuffer()),
        ) !== outcome.sha256
      )
        throw new Error("The written file does not match the validated audio.");
      checkAbort(signal);
      await saveAudioAnalysis(
        this.root,
        path,
        {
          sourceSha256: outcome.sha256,
          sourceBytes: written.size,
          info: outcome.info,
          analysis: outcome.analysis,
          declared: null,
        },
        signal,
      );
      if (!live()) return;
      const plan = this.state.jobs[id]!.plan;
      await this.own(id, () => ({
        phase: "ready",
        lease: null,
        output: {
          path,
          sha256: outcome.sha256,
          bytes: written.size,
          wav: outcome.info,
          analysis: outcome.analysis,
          measurements: outcome.measurements,
        },
        message: `Prepared at ${plan.targetBpm} BPM${plan.semitones ? ` with a ${plan.semitones > 0 ? "+" : ""}${plan.semitones} semitone shift` : ""}.`,
      }));
      this.onOutput?.(path, handle);
    } catch (error) {
      await phaseWrite;
      if (error instanceof Superseded) return;
      if (this.state.recoveryRequired) return;
      if (this.cancelled.has(id) || this.lifetime.signal.aborted) return;
      if (isCancellation(error) && !live()) return;
      await this.own(id, (job) => ({
        phase: "failed",
        lease: null,
        keptOutputs: keepOutput(job),
        outputPath: null,
        message: failureMessage(error),
      })).catch((failure: unknown) => {
        if (!(failure instanceof Superseded)) this.stopForRecovery(failure);
      });
    } finally {
      if (renewal) clearInterval(renewal);
    }
  }

  /** Stop work while folder access is unavailable. Recovery restarts it. */
  suspend(): void {
    this.lifetime.abort();
    this.running?.abort.abort();
    this.running = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.publish({ readable: false, progress: {} });
  }

  resume(root: DirectoryHandle): void {
    this.suspend();
    this.root = root;
    this.lifetime = new AbortController();
    void this.load();
  }

  dispose(): void {
    this.suspend();
    this.listeners.clear();
  }
}
