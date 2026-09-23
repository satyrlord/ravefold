import { validateSamplePath } from "../domain/project.ts";
import type { TagManifest } from "../domain/library-tags.ts";
import {
  checkAbort,
  isCancellation,
  type DirectoryHandle,
  type FileHandle,
} from "../storage/handles.ts";

export interface CatalogRow {
  id: string;
  path: string;
  name: string;
  folder: string;
  handle: FileHandle;
  format: "WAV";
  preparation: "not-prepared";
}

export interface CatalogResult {
  rows: CatalogRow[];
  folders: string[];
  examined: number;
  inaccessible: string[];
  complete: boolean;
}

export interface CatalogOptions {
  signal?: AbortSignal;
  onProgress?: (result: CatalogResult) => void;
}

/** Enumerate file metadata only. Read and validate audio on explicit selection. */
export async function discoverCatalog(
  root: DirectoryHandle,
  options: CatalogOptions = {},
): Promise<CatalogResult> {
  const result: CatalogResult = {
    rows: [],
    folders: [""],
    examined: 0,
    inaccessible: [],
    complete: false,
  };
  const pending = [{ handle: root, path: "" }];
  let visited = 0;
  const publish = () => {
    checkAbort(options.signal);
    options.onProgress?.({
      ...result,
      rows: [...result.rows],
      folders: [...result.folders],
      inaccessible: [...result.inaccessible],
    });
  };
  const checkpoint = async () => {
    if (visited === 1 || visited % 64 === 0) {
      publish();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      checkAbort(options.signal);
    }
  };
  while (pending.length) {
    checkAbort(options.signal);
    const folder = pending.pop()!;
    try {
      for await (const [name, handle] of folder.handle.entries()) {
        checkAbort(options.signal);
        const path = folder.path ? `${folder.path}/${name}` : name;
        visited++;
        try {
          validateSamplePath(
            handle.kind === "directory" ? `${path}/sample.wav` : path,
          );
        } catch {
          if (handle.kind === "directory" || /\.wav$/iu.test(name))
            result.inaccessible.push(path);
          await checkpoint();
          continue;
        }
        if (handle.kind === "directory") {
          result.folders.push(path);
          pending.push({ handle, path });
        } else {
          result.examined++;
          result.rows.push({
            id: path,
            path,
            name,
            folder: folder.path,
            handle,
            format: "WAV",
            preparation: "not-prepared",
          });
        }
        await checkpoint();
      }
    } catch (error) {
      if (isCancellation(error) || options.signal?.aborted || !folder.path)
        throw error;
      result.inaccessible.push(folder.path);
    }
  }
  checkAbort(options.signal);
  result.rows.sort((a, b) => a.path.localeCompare(b.path));
  result.folders.sort((a, b) => a.localeCompare(b));
  result.complete = result.inaccessible.length === 0;
  publish();
  return result;
}

export interface CatalogFilter {
  query?: string;
  folder?: string;
  tag?: string;
}

export function filterCatalog(
  rows: readonly CatalogRow[],
  filter: CatalogFilter,
  manifest?: TagManifest,
): CatalogRow[] {
  const query = filter.query?.trim().toLowerCase() ?? "";
  const folder = filter.folder ?? "";
  const tag = filter.tag?.trim().toLowerCase() ?? "";
  return rows.filter((row) => {
    const tags =
      manifest?.samples[row.path]?.tags.map((value) => value.toLowerCase()) ??
      [];
    return (
      (!folder ||
        row.folder === folder ||
        row.folder.startsWith(`${folder}/`)) &&
      (!tag || tags.includes(tag)) &&
      (!query ||
        row.name.toLowerCase().includes(query) ||
        tags.some((value) => value.includes(query)))
    );
  });
}
