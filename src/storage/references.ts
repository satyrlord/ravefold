import {
  isDirectoryHandle,
  type DirectoryHandle,
  type FolderKind,
} from "./handles.ts";

export interface FolderReferences {
  samples?: DirectoryHandle;
  settings?: DirectoryHandle;
}

export type ReferenceLoad =
  | { available: true; references: FolderReferences }
  | { available: false; references: FolderReferences; message: string };

export type ReferenceSave =
  { available: true } | { available: false; message: string };

const databaseName = "ravefold-folder-references";
const storeName = "references";
const unavailableMessage =
  "Folder references cannot be saved. Select both folders again next time.";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error(unavailableMessage));
      return;
    }
    const request = indexedDB.open(databaseName, 1);
    let expired = false;
    const timeout = setTimeout(() => {
      expired = true;
      reject(new Error(unavailableMessage));
    }, 5000);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => {
      clearTimeout(timeout);
      if (expired) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(unavailableMessage));
    };
    request.onblocked = () => {
      expired = true;
      clearTimeout(timeout);
      reject(new Error(unavailableMessage));
    };
  });
}

export async function loadFolderReferences(): Promise<ReferenceLoad> {
  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase();
    const references = await new Promise<FolderReferences>(
      (resolve, reject) => {
        const transaction = database!.transaction(storeName, "readonly");
        const store = transaction.objectStore(storeName);
        const result: FolderReferences = {};
        for (const kind of ["samples", "settings"] as const) {
          const request = store.get(kind);
          request.onsuccess = () => {
            if (isDirectoryHandle(request.result))
              result[kind] = request.result;
          };
        }
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = transaction.onabort = () =>
          reject(new Error(unavailableMessage));
      },
    );
    return { available: true, references };
  } catch {
    return { available: false, references: {}, message: unavailableMessage };
  } finally {
    database?.close();
  }
}

export async function saveFolderReference(
  kind: FolderKind,
  handle: DirectoryHandle,
): Promise<ReferenceSave> {
  let database: IDBDatabase | undefined;
  try {
    database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database!.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(handle, kind);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () =>
        reject(new Error(unavailableMessage));
    });
    return { available: true };
  } catch {
    return { available: false, message: unavailableMessage };
  } finally {
    database?.close();
  }
}
