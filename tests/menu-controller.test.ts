import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { MenuController } from "../src/ui/menu-controller.ts";
import type {
  AccessState,
  DirectoryHandle,
  FileHandle,
  FolderKind,
  HandleBase,
  WritableHandle,
} from "../src/storage/handles.ts";
import { SETTINGS_FILENAME } from "../src/storage/json-files.ts";
import { MAX_SETTINGS_BYTES } from "../src/domain/settings.ts";
import { projectFixture, settingsFixture } from "./fixtures.ts";

class MemoryFile implements FileHandle {
  readonly kind = "file";
  readonly name: string;
  contents: string;
  failClose = false;
  constructor(name: string, contents = "") {
    this.name = name;
    this.contents = contents;
  }
  async isSameEntry(other: HandleBase): Promise<boolean> {
    return this === other;
  }
  async getFile() {
    return new File([this.contents], this.name);
  }
  async createWritable(): Promise<WritableHandle> {
    let pending = "";
    return {
      write: async (data) => {
        if (typeof data !== "string") throw new Error("Expected metadata.");
        pending = data;
      },
      close: async () => {
        if (this.failClose)
          throw new DOMException("Access ended.", "NotAllowedError");
        this.contents = pending;
      },
      abort: async () => {},
    };
  }
}

class MemoryWavFile extends MemoryFile {
  override async getFile() {
    const bytes = new Uint8Array(48);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    view.setUint32(4, 40, true);
    bytes.set(new TextEncoder().encode("WAVEfmt "), 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 48000, true);
    view.setUint32(28, 96000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    bytes.set(new TextEncoder().encode("data"), 36);
    view.setUint32(40, 4, true);
    return new File([bytes], this.name);
  }
}

class MemoryDirectory implements DirectoryHandle {
  readonly kind = "directory";
  readonly name: string;
  state: AccessState = "granted";
  children = new Map<string, MemoryDirectory | MemoryFile>();
  constructor(name: string) {
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
  ): Promise<MemoryFile> {
    const existing = this.children.get(name);
    if (existing instanceof MemoryFile) return existing;
    if (existing) throw new DOMException("Wrong type.", "TypeMismatchError");
    if (!options?.create) throw new DOMException("Missing.", "NotFoundError");
    const file = new MemoryFile(name);
    this.children.set(name, file);
    return file;
  }
  async getDirectoryHandle(name: string): Promise<MemoryDirectory> {
    const existing = this.children.get(name);
    if (existing instanceof MemoryDirectory) return existing;
    throw new DOMException("Missing.", "NotFoundError");
  }
  async *entries(): AsyncIterableIterator<
    [string, MemoryDirectory | MemoryFile]
  > {
    yield* this.children;
  }
  async resolve(other: HandleBase): Promise<string[] | null> {
    return this === other ? [] : null;
  }
  async removeEntry(name: string) {
    this.children.delete(name);
  }
  file(name: string, contents: string) {
    const file = new MemoryFile(name, contents);
    this.children.set(name, file);
    return file;
  }
}

function picker(context: TestContext, choose: () => Promise<DirectoryHandle>) {
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    "showDirectoryPicker",
  );
  Object.defineProperty(globalThis, "showDirectoryPicker", {
    configurable: true,
    value: choose,
  });
  context.after(() => {
    if (original)
      Object.defineProperty(globalThis, "showDirectoryPicker", original);
    else Reflect.deleteProperty(globalThis, "showDirectoryPicker");
  });
}

function referenceDatabase(
  context: TestContext,
  references: Partial<Record<FolderKind, MemoryDirectory>>,
  delayFirstOpen = false,
) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const firstOpen = Promise.withResolvers<void>();
  let releaseFirstOpen = () => {};
  let opens = 0;
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const transaction = {
        objectStore: () => ({
          get: (kind: FolderKind) => {
            const request: {
              result: MemoryDirectory | undefined;
              onsuccess?: () => void;
            } = { result: references[kind] };
            queueMicrotask(() => request.onsuccess?.());
            return request;
          },
          put: () => {},
        }),
        oncomplete: undefined as (() => void) | undefined,
      };
      setTimeout(() => transaction.oncomplete?.(), 0);
      return transaction;
    },
    close: () => {},
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        const request: {
          result: typeof database;
          onsuccess?: () => void;
        } = { result: database };
        if (++opens === 1) {
          releaseFirstOpen = () => request.onsuccess?.();
          firstOpen.resolve();
          if (!delayFirstOpen) queueMicrotask(releaseFirstOpen);
        } else queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    },
  });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, "indexedDB", original);
    else Reflect.deleteProperty(globalThis, "indexedDB");
  });
  return {
    firstOpen: firstOpen.promise,
    releaseFirstOpen: () => releaseFirstOpen(),
  };
}

function embeddedContext(context: TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { top: {}, self: {} },
  });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
}

function deferredProject() {
  const data = Promise.withResolvers<string>();
  const file = new File(["pending"], "pending.ravefold");
  Object.defineProperty(file, "text", { value: () => data.promise });
  return { file, finish: () => data.resolve(JSON.stringify(projectFixture())) };
}

async function settleWrites(controller: MenuController) {
  for (let index = 0; index < 20; index++) {
    if (!controller.getSnapshot().settingsMessage.startsWith("Saving")) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Settings did not settle.");
}

async function waitForRecovery(controller: MenuController) {
  if (controller.getSnapshot().recoveries.length) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Recovery choice did not load."));
    }, 1000);
    const unsubscribe = controller.subscribe(() => {
      if (!controller.getSnapshot().recoveries.length) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

test("invalid project reads preserve the last valid selection", async () => {
  const controller = new MenuController(false, () => {});
  controller.newProject();
  const previous = controller.getSnapshot().pending;
  await controller.openProject(new File(["{"], "invalid.ravefold"));
  assert.equal(controller.getSnapshot().pending, previous);
  assert.equal(controller.getSnapshot().projectBusy, false);
  assert.match(controller.getSnapshot().message, /not valid JSON/u);
  controller.dispose();
});

test("an older project read cannot replace a newer selection", async () => {
  const controller = new MenuController(false, () => {});
  const deferred = deferredProject();
  const reading = controller.openProject(deferred.file);
  controller.newProject();
  const newest = controller.getSnapshot().pending;
  deferred.finish();
  await reading;
  assert.equal(controller.getSnapshot().pending, newest);
  assert.equal(controller.getSnapshot().projectBusy, false);
  controller.dispose();
});

test("cancelling a project check keeps the prior valid selection", async () => {
  const controller = new MenuController(false, () => {});
  controller.newProject();
  const previous = controller.getSnapshot().pending;
  const deferred = deferredProject();
  const reading = controller.openProject(deferred.file);
  controller.cancelProjectCheck();
  deferred.finish();
  await reading;
  assert.equal(controller.getSnapshot().pending, previous);
  assert.equal(controller.getSnapshot().projectBusy, false);
  controller.dispose();
});

test("recovery selection cancels an older project read and clears busy state", async (context) => {
  const settings = new MemoryDirectory("settings");
  const recovery = new MemoryDirectory("recovery");
  settings.children.set("recovery", recovery);
  recovery.file("copy.ravefold.json", JSON.stringify(projectFixture()));
  picker(context, async () => settings);
  const controller = new MenuController(false, () => {});
  context.after(() => controller.dispose());
  await controller.selectFolder("settings");
  await waitForRecovery(controller);
  assert.equal(controller.getSnapshot().recoveries.length, 1);
  const deferred = deferredProject();
  const reading = controller.openProject(deferred.file);
  controller.selectRecovery(0);
  deferred.finish();
  await reading;
  assert.equal(controller.getSnapshot().pending?.mode, "recover");
  assert.equal(controller.getSnapshot().projectBusy, false);
});

test("a slow recovery scan does not block new project entry", async (context) => {
  const settings = new MemoryDirectory("settings");
  const recovery = new MemoryDirectory("recovery");
  const samples = new MemoryDirectory("samples");
  samples.children.set("sample.wav", new MemoryWavFile("sample.wav"));
  settings.children.set("recovery", recovery);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  recovery.entries = async function* () {
    entered.resolve();
    await release.promise;
  };
  let selections = 0;
  picker(context, async () => (selections++ === 0 ? settings : samples));
  let entries = 0;
  const controller = new MenuController(false, () => entries++);
  context.after(() => controller.dispose());
  const selecting = controller.selectFolder("settings");
  await entered.promise;
  try {
    assert.equal(controller.getSnapshot().settings.status, "ready");
    controller.newProject();
    await controller.selectFolder("samples");
    await controller.enter();
    assert.equal(entries, 1);
    assert.equal(controller.getSnapshot().entry?.mode, "new");
  } finally {
    release.resolve();
    await selecting;
  }
});

test("a late folder picker cannot replace a newer selected folder", async (context) => {
  const previous = new MemoryDirectory("previous");
  const latest = new MemoryDirectory("latest");
  const delayed = Promise.withResolvers<DirectoryHandle>();
  let calls = 0;
  picker(context, () =>
    ++calls === 1 ? delayed.promise : Promise.resolve(latest),
  );
  const controller = new MenuController(false, () => {});
  context.after(() => controller.dispose());
  const oldSelection = controller.selectFolder("settings");
  await controller.selectFolder("settings");
  delayed.resolve(previous);
  await oldSelection;
  assert.equal(controller.getSnapshot().settings.handle, latest);
  assert.equal(controller.getSnapshot().settings.status, "ready");
});

test("an old permission retry cannot replace a newer selected folder", async (context) => {
  const previous = new MemoryDirectory("previous");
  const latest = new MemoryDirectory("latest");
  let chosen = previous;
  picker(context, async () => chosen);
  const controller = new MenuController(false, () => {});
  context.after(() => controller.dispose());
  await controller.selectFolder("settings");
  previous.state = "prompt";
  const started = Promise.withResolvers<void>();
  const access = Promise.withResolvers<AccessState>();
  previous.requestPermission = () => {
    started.resolve();
    return access.promise;
  };
  const retrying = controller.retry("settings");
  await started.promise;
  chosen = latest;
  await controller.selectFolder("settings");
  previous.state = "granted";
  access.resolve("granted");
  await retrying;
  assert.equal(controller.getSnapshot().settings.handle, latest);
});

test("a denied retry cannot leave an earlier folder check ready", async (context) => {
  const settings = new MemoryDirectory("settings");
  const originalEntries = settings.entries.bind(settings);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  settings.entries = async function* () {
    entered.resolve();
    await release.promise;
    yield* originalEntries();
  };
  picker(context, async () => settings);
  const controller = new MenuController(false, () => {});
  context.after(() => controller.dispose());
  const selecting = controller.selectFolder("settings");
  await entered.promise;
  settings.state = "denied";
  await controller.retry("settings");
  assert.equal(controller.getSnapshot().settings.status, "error");
  release.resolve();
  await selecting;
  assert.equal(controller.getSnapshot().settings.status, "error");
});

test("stopping a retry blocks its pending permission result", async (context) => {
  const settings = new MemoryDirectory("settings");
  picker(context, async () => settings);
  const controller = new MenuController(false, () => {});
  context.after(() => controller.dispose());
  await controller.selectFolder("settings");
  settings.state = "prompt";
  const started = Promise.withResolvers<void>();
  const access = Promise.withResolvers<AccessState>();
  settings.requestPermission = () => {
    started.resolve();
    return access.promise;
  };
  const retrying = controller.retry("settings");
  await started.promise;
  controller.cancelDiscovery("settings");
  settings.state = "granted";
  access.resolve("granted");
  await retrying;
  assert.equal(controller.getSnapshot().settings.status, "error");
  assert.match(controller.getSnapshot().settings.message, /stopped/u);
});

test("selecting one folder during startup keeps the other saved reference", async (context) => {
  const savedSamples = new MemoryDirectory("saved samples");
  const savedSettings = new MemoryDirectory("saved settings");
  const selectedSamples = new MemoryDirectory("selected samples");
  const database = referenceDatabase(
    context,
    { samples: savedSamples, settings: savedSettings },
    true,
  );
  picker(context, async () => selectedSamples);
  const controller = new MenuController(false, () => {});
  context.after(() => controller.dispose());
  const starting = controller.start();
  await database.firstOpen;
  await controller.selectFolder("samples");
  database.releaseFirstOpen();
  await starting;
  assert.equal(controller.getSnapshot().samples.handle, selectedSamples);
  assert.equal(controller.getSnapshot().settings.handle, savedSettings);
});

test("saved references to the same folder cannot become ready", async (context) => {
  const shared = new MemoryDirectory("shared");
  shared.children.set("sample.wav", new MemoryWavFile("sample.wav"));
  referenceDatabase(context, { samples: shared, settings: shared });
  const controller = new MenuController(false, () => {});
  context.after(() => controller.dispose());
  await controller.start();
  assert.equal(controller.getSnapshot().samples.status, "error");
  assert.equal(controller.getSnapshot().settings.status, "error");
  assert.match(controller.getSnapshot().samples.message, /separate folders/u);
  assert.match(controller.getSnapshot().settings.message, /separate folders/u);
});

test("embedded folder denial keeps entry blocked without file operations", async (context) => {
  embeddedContext(context);
  const settings = new MemoryDirectory("settings");
  settings.state = "denied";
  picker(context, async () => settings);
  const controller = new MenuController(false, () => {
    assert.fail("Denied folder access must block entry.");
  });
  context.after(() => controller.dispose());
  controller.newProject();
  await controller.selectFolder("settings");
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = controller.getSnapshot();
    assert.equal(state.settings.status, "error");
    assert.equal(state.settings.accessDenied, true);
    assert.match(state.settings.message, /host can restrict access/u);
    assert.equal(settings.children.size, 0);
    assert.equal(state.entry, undefined);
    await controller.retry("settings");
  }
  await controller.enter();
  assert.equal(controller.getSnapshot().entry, undefined);
});

test("embedded views with permission can select a folder and detect revocation", async (context) => {
  embeddedContext(context);
  const settings = new MemoryDirectory("settings");
  picker(context, async () => settings);
  const controller = new MenuController(false, () => {});
  context.after(() => controller.dispose());
  await controller.selectFolder("settings");
  await settleWrites(controller);
  assert.equal(controller.getSnapshot().settings.status, "ready");
  assert.equal(controller.getSnapshot().settings.accessDenied, false);
  const previous = settings.children.get(SETTINGS_FILENAME);
  assert.ok(previous);
  settings.state = "denied";
  await controller.refreshPermissions();
  assert.equal(controller.getSnapshot().settings.status, "error");
  assert.equal(controller.getSnapshot().settings.accessDenied, true);
  assert.equal(settings.children.get(SETTINGS_FILENAME), previous);
  settings.state = "granted";
  await controller.retry("settings");
  await settleWrites(controller);
  assert.equal(controller.getSnapshot().settings.status, "ready");
  assert.equal(controller.getSnapshot().settings.accessDenied, false);
});

test("an old permission refresh cannot revoke a renewed folder grant", async (context) => {
  const settings = new MemoryDirectory("settings");
  picker(context, async () => settings);
  const controller = new MenuController(false, () => {});
  context.after(() => controller.dispose());
  await controller.selectFolder("settings");
  await settleWrites(controller);

  const started = Promise.withResolvers<void>();
  const oldResult = Promise.withResolvers<AccessState>();
  let queries = 0;
  settings.queryPermission = () => {
    if (++queries === 1) {
      started.resolve();
      return oldResult.promise;
    }
    return Promise.resolve("granted");
  };

  const refreshing = controller.refreshPermissions();
  await started.promise;
  await controller.retry("settings");
  assert.equal(controller.getSnapshot().settings.status, "ready");
  oldResult.resolve("denied");
  await refreshing;
  assert.equal(controller.getSnapshot().settings.status, "ready");
  assert.equal(controller.getSnapshot().settings.accessDenied, false);
});

test("a pending embedded permission does not report host denial", async (context) => {
  embeddedContext(context);
  const settings = new MemoryDirectory("settings");
  settings.state = "prompt";
  picker(context, async () => settings);
  const controller = new MenuController(false, () => {});
  context.after(() => controller.dispose());
  await controller.selectFolder("settings");
  assert.equal(controller.getSnapshot().settings.accessDenied, false);
  assert.equal(
    controller.getSnapshot().settings.message,
    "Read and write permission is required.",
  );
  assert.equal(settings.children.size, 0);
});

test("session choices merge with saved settings and persist only in the selected folder", async (context) => {
  const settings = new MemoryDirectory("settings");
  settings.file(SETTINGS_FILENAME, JSON.stringify(settingsFixture()));
  picker(context, async () => settings);
  const controller = new MenuController(true, () => {});
  context.after(() => controller.dispose());
  controller.setAppearance("skin", "reference-3");
  await controller.selectFolder("settings");
  await settleWrites(controller);
  const expected = { ...settingsFixture().appearance, skin: "reference-3" };
  assert.deepEqual(controller.getSnapshot().appearance, expected);
  assert.deepEqual(
    JSON.parse((await settings.getFileHandle(SETTINGS_FILENAME)).contents),
    { schemaVersion: 1, appearance: expected },
  );
});

test("corrupt and oversized settings stay unchanged with a recoverable status", async (context) => {
  let selected = new MemoryDirectory("corrupt");
  picker(context, async () => selected);
  for (const content of [
    "{bad",
    JSON.stringify(settingsFixture()) + " ".repeat(MAX_SETTINGS_BYTES),
  ]) {
    selected = new MemoryDirectory("settings");
    const file = selected.file(SETTINGS_FILENAME, content);
    const controller = new MenuController(false, () => {});
    await controller.selectFolder("settings");
    await settleWrites(controller);
    assert.equal(file.contents, content);
    assert.match(controller.getSnapshot().settingsMessage, /invalid/u);
    assert.equal(controller.getSnapshot().appearance.skin, "reference-2");
    controller.dispose();
  }
});

test("unreadable settings keep entry blocked until folder access returns", async (context) => {
  const settings = new MemoryDirectory("settings");
  const samples = new MemoryDirectory("samples");
  samples.children.set("sample.wav", new MemoryWavFile("sample.wav"));
  const file = settings.file(
    SETTINGS_FILENAME,
    JSON.stringify(settingsFixture()),
  );
  file.getFile = async () => {
    const unreadable = new File([file.contents], file.name);
    Object.defineProperty(unreadable, "text", {
      value: async () => {
        throw new DOMException("Access ended.", "NotReadableError");
      },
    });
    return unreadable;
  };
  let selections = 0;
  picker(context, async () => (selections++ === 0 ? settings : samples));
  const controller = new MenuController(false, () => {
    assert.fail("Unreadable settings must block entry.");
  });
  context.after(() => controller.dispose());
  await controller.selectFolder("settings");
  await controller.selectFolder("samples");
  controller.newProject();
  assert.equal(controller.getSnapshot().settings.status, "error");
  assert.match(controller.getSnapshot().settingsMessage, /cannot be read/u);
  await controller.enter();
  assert.equal(controller.getSnapshot().entry, undefined);
});

test("failed settings writes retain the previous file and show unsaved status", async (context) => {
  const settings = new MemoryDirectory("settings");
  const previous = JSON.stringify(settingsFixture());
  const file = settings.file(SETTINGS_FILENAME, previous);
  file.failClose = true;
  picker(context, async () => settings);
  const controller = new MenuController(false, () => {});
  context.after(() => controller.dispose());
  await controller.selectFolder("settings");
  controller.setAppearance("mode", "light");
  await settleWrites(controller);
  assert.equal(file.contents, previous);
  assert.match(controller.getSnapshot().settingsMessage, /not saved/u);
});
