import {
  createEmptyProject,
  parseProject,
  projectSamplePaths,
  validateProject,
  MAX_PROJECT_BYTES,
} from "../domain/project.ts";
import type { Project } from "../domain/project.ts";
import {
  defaultAppearance,
  mergeAppearance,
  validateSettings,
  MAX_SETTINGS_BYTES,
} from "../domain/settings.ts";
import type { Appearance } from "../domain/settings.ts";
import { createEntryResult } from "../domain/entry.ts";
import type { EntryMode, EntryResult } from "../domain/entry.ts";
import {
  accessDeniedMessage,
  isAccessDenied,
  pickerAvailable,
  pickFolder,
  permission,
  isCancellation,
} from "../storage/handles.ts";
import type { DirectoryHandle, FolderKind } from "../storage/handles.ts";
import {
  validateFolder,
  checkFolderSeparation,
  probeWriteAccess,
} from "../storage/folders.ts";
import type { DiscoveryResult } from "../storage/folders.ts";
import {
  loadFolderReferences,
  saveFolderReference,
} from "../storage/references.ts";
import {
  readJson,
  writeValidatedJson,
  SETTINGS_FILENAME,
} from "../storage/json-files.ts";
import { readRecoveryCandidates } from "../storage/recovery.ts";
import { resolveMissingSamples } from "../storage/missing.ts";
import { validateWav } from "../domain/wav.ts";
import { importArchiveSamples, listArchiveMembers } from "../archive/import.ts";

export interface FolderState {
  handle?: DirectoryHandle;
  status: "empty" | "checking" | "ready" | "error";
  message: string;
  scanning: boolean;
  accessDenied: boolean;
  discovery?: DiscoveryResult;
}
export interface PendingProject {
  mode: EntryMode;
  project: Project;
}
export interface RecoveryChoice {
  name: string;
  project: Project;
}
export interface ArchiveState {
  status:
    | "idle"
    | "choosing"
    | "listing"
    | "importing"
    | "checking"
    | "complete"
    | "error"
    | "cancelled";
  completed: number;
  total: number;
  message: string;
}
export function archiveBusy(state: ArchiveState): boolean {
  return ["choosing", "listing", "importing", "checking"].includes(
    state.status,
  );
}
export interface MenuState {
  appearance: Appearance;
  samples: FolderState;
  settings: FolderState;
  pending?: PendingProject;
  recoveries: RecoveryChoice[];
  recoveryMessage: string;
  settingsMessage: string;
  persistenceMessage: string;
  message: string;
  projectBusy: boolean;
  entering: boolean;
  entry?: EntryResult;
  supported: boolean;
  archive: ArchiveState;
}
const emptyFolder = (): FolderState => ({
  status: "empty",
  message: "No folder selected.",
  scanning: false,
  accessDenied: false,
});
const failureMessage = (error: unknown) =>
  isAccessDenied(error)
    ? accessDeniedMessage()
    : "The folder could not be checked. Select the folder or retry access.";

export class MenuController {
  private state: MenuState;
  private listeners = new Set<() => void>();
  private changed = new Set<keyof Appearance>();
  private defaults: Appearance;
  private tasks: Partial<Record<FolderKind, AbortController>> = {};
  private settingsTask = new AbortController();
  private settingsReadable = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private projectSequence = 0;
  private selections: Record<FolderKind, number> = { samples: 0, settings: 0 };
  private disposed = false;
  private started = false;
  private onEntry: (entry: EntryResult) => void;
  private entryTask?: AbortController;
  private archiveTask?: AbortController;

  constructor(reducedMotion: boolean, onEntry: (entry: EntryResult) => void) {
    this.onEntry = onEntry;
    this.defaults = defaultAppearance(reducedMotion);
    this.state = {
      appearance: this.defaults,
      samples: emptyFolder(),
      settings: emptyFolder(),
      recoveries: [],
      recoveryMessage: "",
      settingsMessage:
        "Changes stay in this session until settings access is ready.",
      persistenceMessage: "",
      message: "",
      projectBusy: false,
      entering: false,
      supported: pickerAvailable(),
      archive: { status: "idle", completed: 0, total: 0, message: "" },
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<MenuState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private folder(kind: FolderKind, patch: Partial<FolderState>) {
    this.update({ [kind]: { ...this.state[kind], ...patch } });
  }

  async start() {
    if (this.started) return;
    this.started = true;
    const initialSelections = { ...this.selections };
    const result = await loadFolderReferences();
    if (this.disposed) return;
    // Reference restoration never requests a permission prompt.
    if (!result.available)
      this.update({
        persistenceMessage:
          "Folder references cannot be saved. Select folders again next session.",
      });
    const references = result.references;
    const restored: Partial<Record<FolderKind, DirectoryHandle>> = {};
    for (const kind of ["samples", "settings"] as const) {
      const handle = references[kind];
      if (handle && initialSelections[kind] === this.selections[kind]) {
        restored[kind] = handle;
        this.folder(kind, { handle });
      }
    }
    await Promise.all(
      (["samples", "settings"] as const).map(async (kind) => {
        const handle = restored[kind];
        if (handle) await this.check(kind, handle);
      }),
    );
  }
  dispose() {
    this.disposed = true;
    this.tasks.samples?.abort();
    this.tasks.settings?.abort();
    this.settingsTask.abort();
    this.entryTask?.abort();
    this.archiveTask?.abort();
    this.listeners.clear();
  }

  private async accessibleOther(kind: FolderKind) {
    const handle =
      this.state[kind === "samples" ? "settings" : "samples"].handle;
    if (!handle) return undefined;
    return (await permission(handle).catch(() => "denied")) === "granted"
      ? handle
      : undefined;
  }

  async selectFolder(kind: FolderKind) {
    if (kind === "samples") this.cancelArchive();
    const sequence = ++this.selections[kind];
    try {
      const handle = await pickFolder(kind);
      if (sequence !== this.selections[kind] || this.disposed) return;
      const other = await this.accessibleOther(kind);
      const separate = !other || (await checkFolderSeparation(handle, other));
      if (sequence !== this.selections[kind] || this.disposed) return;
      if (!separate) {
        this.update({
          message:
            "Select separate folders. Neither folder can contain the other.",
        });
        return;
      }
      await this.check(kind, handle);
    } catch (error) {
      if (sequence !== this.selections[kind] || this.disposed) return;
      this.update({
        message: isCancellation(error)
          ? "Folder selection cancelled."
          : failureMessage(error),
      });
    }
  }
  async retry(kind: FolderKind) {
    if (kind === "samples") this.cancelArchive();
    const handle = this.state[kind].handle;
    if (!handle) return this.selectFolder(kind);
    const sequence = ++this.selections[kind];
    this.tasks[kind]?.abort();
    this.entryTask?.abort();
    this.folder(kind, {
      status: "checking",
      scanning: true,
      accessDenied: false,
      discovery: undefined,
      message: "Checking folder access.",
    });
    this.update({ entry: undefined });
    // Start permission work from the user's click, before other asynchronous work.
    try {
      const access = await permission(handle, true);
      if (sequence !== this.selections[kind] || this.disposed) return;
      if (access !== "granted") {
        this.folder(kind, {
          status: "error",
          scanning: false,
          accessDenied: access === "denied",
          message:
            access === "denied"
              ? accessDeniedMessage()
              : "Read and write permission is required.",
        });
        return;
      }
      await this.check(kind, handle);
    } catch (error) {
      if (sequence !== this.selections[kind] || this.disposed) return;
      this.folder(kind, {
        status: "error",
        scanning: false,
        accessDenied: isAccessDenied(error),
        message: failureMessage(error),
      });
    }
  }
  cancelDiscovery(kind: FolderKind) {
    this.selections[kind]++;
    this.tasks[kind]?.abort();
    this.folder(kind, {
      scanning: false,
      status: this.state[kind].discovery?.files.length ? "ready" : "error",
      message: "Folder check stopped. Retry to complete the check.",
    });
  }

  async importArchive() {
    if (archiveBusy(this.state.archive)) return;
    const task = new AbortController();
    this.archiveTask = task;
    let handle = this.state.samples.handle;
    let newSelection = false;
    this.update({
      archive: {
        status: "choosing",
        completed: 0,
        total: 0,
        message: handle
          ? "Checking Samples folder access."
          : "Choose a folder for the WAV samples.",
      },
    });
    try {
      if (!handle) {
        handle = await pickFolder("samples");
        newSelection = true;
      }
      task.signal.throwIfAborted();
      if ((await permission(handle, true)) !== "granted")
        throw new Error("Read and write permission is required.");
      const settings = this.state.settings.handle;
      if (settings && !(await checkFolderSeparation(handle, settings)))
        throw new Error("Select separate sample and settings folders.");
      await probeWriteAccess(handle, task.signal);
      task.signal.throwIfAborted();
      if (newSelection) {
        this.selections.samples++;
        this.tasks.samples?.abort();
        this.entryTask?.abort();
        this.folder("samples", {
          handle,
          status: "checking",
          scanning: false,
          accessDenied: false,
          discovery: undefined,
          message: "Importing archive samples.",
        });
        this.update({ entry: undefined });
      }
      this.update({
        archive: {
          status: "listing",
          completed: 0,
          total: 0,
          message: "Reading the ISO file list.",
        },
      });
      const members = await listArchiveMembers(task.signal);
      task.signal.throwIfAborted();
      this.update({
        archive: {
          status: "importing",
          completed: 0,
          total: members.length,
          message: `Downloading and converting 0 of ${members.length} samples.`,
        },
      });
      await importArchiveSamples(handle, members, task.signal, (progress) => {
        if (task.signal.aborted) return;
        this.update({
          archive: {
            status: "importing",
            ...progress,
            message: `Downloading and converting ${progress.completed} of ${progress.total} samples.`,
          },
        });
      });
      task.signal.throwIfAborted();
      this.update({
        archive: {
          status: "checking",
          completed: members.length,
          total: members.length,
          message: "Checking the new WAV sample folder.",
        },
      });
      await this.check("samples", handle);
      task.signal.throwIfAborted();
      if (
        this.state.samples.handle !== handle ||
        this.state.samples.status !== "ready"
      )
        throw new Error("The new sample folder could not be validated.");
      this.update({
        archive: {
          status: "complete",
          completed: members.length,
          total: members.length,
          message: `${members.length} WAV sample${members.length === 1 ? "" : "s"} imported into ${handle.name}/Rave eJay ISO.`,
        },
      });
    } catch (error) {
      if (task.signal.aborted || isCancellation(error)) {
        if (newSelection && handle === this.state.samples.handle)
          this.folder("samples", {
            status: "error",
            scanning: false,
            message: "Archive import stopped. Retry the import.",
          });
        this.update({
          archive: {
            ...this.state.archive,
            status: "cancelled",
            message:
              !task.signal.aborted && this.state.archive.status === "choosing"
                ? "Folder selection cancelled."
                : "Import stopped. Files already added remain in the Samples folder.",
          },
        });
      } else {
        if (newSelection && handle === this.state.samples.handle)
          this.folder("samples", {
            status: "error",
            message: "Archive import did not complete. Retry the import.",
          });
        this.update({
          archive: {
            ...this.state.archive,
            status: "error",
            message: `${error instanceof TypeError && /fetch/iu.test(error.message) ? "The archive could not be reached" : error instanceof Error ? error.message.replace(/[.!?]+$/u, "") : "Archive import failed"}. Retry the import. Files already added remain in the Samples folder.`,
          },
        });
      }
    } finally {
      if (this.archiveTask === task) this.archiveTask = undefined;
    }
  }

  cancelArchive() {
    this.archiveTask?.abort();
  }
  private async check(kind: FolderKind, handle: DirectoryHandle) {
    this.entryTask?.abort();
    this.tasks[kind]?.abort();
    const task = new AbortController();
    this.tasks[kind] = task;
    if (kind === "settings") {
      this.settingsTask.abort();
      this.settingsTask = new AbortController();
      this.settingsReadable = false;
      this.update({
        recoveries: [],
        recoveryMessage: "",
        settingsMessage: "Checking settings access.",
      });
    }
    this.folder(kind, {
      handle,
      status: "checking",
      accessDenied: false,
      scanning: true,
      message: "Checking folder access.",
      discovery: undefined,
    });
    this.update({ entry: undefined, message: "" });
    try {
      const result = await validateFolder(handle, kind, {
        other: await this.accessibleOther(kind),
        signal: task.signal,
        onProgress: (discovery) => {
          if (task.signal.aborted) return;
          this.folder(kind, {
            discovery,
            status: discovery.files.length ? "ready" : "checking",
            message: discovery.files.length
              ? `${discovery.files.length} supported WAV files found. Discovery continues.`
              : `${discovery.examined} files examined.`,
          });
        },
      });
      if (task.signal.aborted) return;
      this.folder(kind, {
        status: result.valid
          ? kind === "settings"
            ? "checking"
            : "ready"
          : "error",
        message: result.message,
        accessDenied: result.code === "permission-denied",
        discovery: result.discovery,
        scanning: kind === "settings" && result.valid,
      });
      if (result.valid) {
        if (kind === "settings") {
          const settingsAvailable = await this.loadSettings(
            handle,
            task.signal,
          );
          if (task.signal.aborted) return;
          if (!settingsAvailable) {
            this.folder(kind, {
              status: "error",
              message: "Settings cannot be read. Retry folder access.",
              scanning: false,
            });
            return;
          }
          this.folder(kind, {
            status: "ready",
            message: result.message,
            scanning: false,
          });
          if (this.settingsReadable) this.saveAppearance();
          void this.loadRecoveries(handle, task.signal);
        }
        const persisted = await saveFolderReference(kind, handle);
        if (task.signal.aborted) return;
        if (!persisted.available)
          this.update({
            persistenceMessage:
              "Folder references cannot be saved. Select folders again next session.",
          });
      }
    } catch (error) {
      if (!task.signal.aborted)
        this.folder(kind, {
          status: "error",
          scanning: false,
          accessDenied: isAccessDenied(error),
          message: failureMessage(error),
        });
    }
  }
  private async loadSettings(
    handle: DirectoryHandle,
    signal: AbortSignal,
  ): Promise<boolean> {
    const saved = await readJson(
      handle,
      SETTINGS_FILENAME,
      validateSettings,
      MAX_SETTINGS_BYTES,
    );
    if (signal.aborted) return false;
    this.settingsReadable =
      saved.status === "valid" || saved.status === "missing";
    const appearance = mergeAppearance(
      this.defaults,
      saved.status === "valid" ? saved.value.appearance : undefined,
      this.state.appearance,
      this.changed,
    );
    this.update({
      appearance,
      settingsMessage:
        saved.status === "invalid"
          ? "Saved settings are invalid. Select another settings folder or repair the file, then retry. The file is unchanged."
          : saved.status === "unavailable"
            ? "Settings cannot be read. Changes are not saved. Retry folder access."
            : "Appearance is ready to save.",
    });
    return saved.status !== "unavailable";
  }
  private async loadRecoveries(handle: DirectoryHandle, signal: AbortSignal) {
    this.update({ recoveryMessage: "Checking recovery copies." });
    try {
      const recovered = await readRecoveryCandidates(
        handle,
        validateProject,
        signal,
      );
      if (signal.aborted) return;
      this.update({
        recoveries: recovered.valid.map((item) => ({
          name: item.filename,
          project: item.value,
        })),
        recoveryMessage:
          recovered.unavailable ??
          (recovered.invalid.length
            ? `${recovered.invalid.length} recovery files could not be opened.`
            : ""),
      });
    } catch {
      if (!signal.aborted)
        this.update({
          recoveryMessage:
            "Recovery copies cannot be read. Check folder access.",
        });
    }
  }
  setAppearance<K extends keyof Appearance>(field: K, value: Appearance[K]) {
    this.changed.add(field);
    this.update({ appearance: { ...this.state.appearance, [field]: value } });
    this.saveAppearance();
  }
  private saveAppearance() {
    const handle = this.state.settings.handle;
    if (this.state.settings.status !== "ready" || !handle) {
      this.update({
        settingsMessage:
          "Changes stay in this session. Restore settings access to save.",
      });
      return;
    }
    if (!this.settingsReadable || this.settingsTask.signal.aborted) return;
    const appearance = { ...this.state.appearance };
    const signal = this.settingsTask.signal;
    this.update({ settingsMessage: "Saving appearance." });
    this.writeQueue = this.writeQueue.then(async () => {
      if (signal.aborted) return;
      try {
        if ((await permission(handle)) !== "granted")
          throw new Error("No permission");
        await writeValidatedJson(
          handle,
          SETTINGS_FILENAME,
          { schemaVersion: 1, appearance },
          validateSettings,
          signal,
        );
        if (
          !signal.aborted &&
          Object.keys(appearance).every(
            (key) =>
              appearance[key as keyof Appearance] ===
              this.state.appearance[key as keyof Appearance],
          )
        )
          this.update({
            settingsMessage: "Appearance saved in your settings folder.",
          });
      } catch {
        if (!signal.aborted)
          this.update({
            settingsMessage:
              "Appearance is not saved. Retry settings access. The last valid file is unchanged.",
          });
      }
    });
  }
  newProject() {
    this.projectSequence++;
    this.update({
      pending: { mode: "new", project: createEmptyProject() },
      projectBusy: false,
      message: "",
      entry: undefined,
    });
  }
  cancelProject() {
    this.projectSequence++;
    this.update({
      pending: undefined,
      projectBusy: false,
      message: "Project selection cancelled.",
      entry: undefined,
    });
  }
  cancelProjectCheck() {
    this.projectSequence++;
    this.update({ projectBusy: false, message: "Project check cancelled." });
  }
  async openProject(file: File) {
    const sequence = ++this.projectSequence;
    this.update({ projectBusy: true, message: "Reading project." });
    try {
      if (file.size > MAX_PROJECT_BYTES)
        throw new Error("The project file is too large.");
      const project = parseProject(await file.text());
      if (sequence === this.projectSequence)
        this.update({
          pending: { mode: "open", project },
          entry: undefined,
          message: "Project selected.",
        });
    } catch (error) {
      if (sequence === this.projectSequence)
        this.update({
          message:
            error instanceof Error
              ? error.message
              : "The project could not be read.",
        });
    } finally {
      if (sequence === this.projectSequence)
        this.update({ projectBusy: false });
    }
  }
  selectRecovery(index: number) {
    const recovery = this.state.recoveries[index];
    if (recovery) {
      this.projectSequence++;
      this.update({
        pending: { mode: "recover", project: recovery.project },
        projectBusy: false,
        entry: undefined,
        message: "Recovery selected. Your files are unchanged.",
      });
    }
  }
  async refreshPermissions() {
    for (const kind of ["samples", "settings"] as const) {
      const handle = this.state[kind].handle;
      if (!handle || this.state[kind].status !== "ready") continue;
      const selection = this.selections[kind];
      let accessDenied = false;
      try {
        const access = await permission(handle);
        if (access === "granted") continue;
        accessDenied = access === "denied";
      } catch (error) {
        accessDenied = isAccessDenied(error);
      }
      if (
        selection !== this.selections[kind] ||
        handle !== this.state[kind].handle ||
        this.state[kind].status !== "ready"
      )
        continue;
      this.tasks[kind]?.abort();
      if (kind === "settings") {
        this.settingsTask.abort();
        this.settingsReadable = false;
      }
      this.folder(kind, {
        status: "error",
        scanning: false,
        accessDenied,
        message: accessDenied
          ? accessDeniedMessage()
          : "Folder access has ended. Retry access.",
      });
      this.update({ entry: undefined });
    }
  }
  async enter() {
    if (
      this.state.entry ||
      this.state.entering ||
      !this.state.pending ||
      this.state.samples.status !== "ready" ||
      this.state.settings.status !== "ready" ||
      this.state.projectBusy ||
      archiveBusy(this.state.archive)
    )
      return;
    const { pending, samples, settings } = this.state;
    if (!samples.handle || !settings.handle) return;
    const sampleHandle = samples.handle,
      settingsHandle = settings.handle;
    const projectSequence = this.projectSequence;
    const task = new AbortController();
    this.entryTask = task;
    this.update({ entering: true, message: "Checking entry access." });
    try {
      await this.refreshPermissions();
      if (
        this.state.samples.status !== "ready" ||
        this.state.settings.status !== "ready"
      )
        throw new Error("Both folders require read and write access.");
      if (!(await checkFolderSeparation(sampleHandle, settingsHandle)))
        throw new Error("Select separate sample and settings folders.");
      await probeWriteAccess(settingsHandle, task.signal);
      await probeWriteAccess(sampleHandle, task.signal);
      const rootEntries = sampleHandle.entries();
      await rootEntries.next();
      await rootEntries.return?.();
      // Entry rechecks a known source while catalogue discovery continues.
      let validSource = false;
      for (const source of samples.discovery?.files ?? []) {
        task.signal.throwIfAborted();
        try {
          validSource = (
            await validateWav(await source.handle.getFile(), task.signal)
          ).valid;
        } catch {
          task.signal.throwIfAborted();
        }
        if (validSource) break;
      }
      task.signal.throwIfAborted();
      if (!validSource) {
        const message =
          "No validated WAV file is available. Retry the sample folder check.";
        this.folder("samples", { status: "error", message });
        throw new Error(message);
      }
      const missing = await resolveMissingSamples(
        sampleHandle,
        projectSamplePaths(pending.project),
        task.signal,
      );
      await this.refreshPermissions();
      if (
        this.state.samples.status !== "ready" ||
        this.state.settings.status !== "ready"
      )
        throw new Error("Folder access changed. Retry access.");
      task.signal.throwIfAborted();
      if (
        sampleHandle !== this.state.samples.handle ||
        settingsHandle !== this.state.settings.handle ||
        projectSequence !== this.projectSequence
      )
        return;
      const entry = createEntryResult(
        pending.mode,
        pending.project,
        sampleHandle,
        settingsHandle,
        missing,
        this.state.appearance,
      );
      this.update({ entry, message: "Project is ready." });
      this.onEntry(entry);
    } catch (error) {
      this.update({
        message: task.signal.aborted
          ? "Entry check cancelled."
          : error instanceof Error
            ? error.message
            : "Project entry failed. Retry folder access.",
      });
    } finally {
      this.update({ entering: false });
    }
  }
  cancelEntry() {
    this.entryTask?.abort();
  }
  returnToMenu() {
    this.update({ entry: undefined, message: "" });
  }
}
