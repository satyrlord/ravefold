import { validateSamplePath } from "../domain/project.ts";
import { checkAbort, type DirectoryHandle } from "./handles.ts";

export async function resolveMissingSamples(
  root: DirectoryHandle,
  paths: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const missing: string[] = [];
  for (const path of new Set(paths)) {
    checkAbort(signal);
    const parts = validateSamplePath(path).split("/");
    let directory = root;
    try {
      for (const part of parts.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(part);
        checkAbort(signal);
      }
      await (await directory.getFileHandle(parts.at(-1)!)).getFile();
    } catch {
      checkAbort(signal);
      missing.push(path);
    }
  }
  checkAbort(signal);
  return missing;
}
