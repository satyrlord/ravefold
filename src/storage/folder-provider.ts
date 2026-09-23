import type { DirectoryHandle, FolderKind } from "./handles.ts";

export interface FolderProvider {
  roots(): Promise<Partial<Record<FolderKind, DirectoryHandle>>>;
  pick(kind: FolderKind): Promise<DirectoryHandle>;
}

let provider: FolderProvider | undefined;

export function configureFolderProvider(
  value: FolderProvider | undefined,
): void {
  provider = value;
}

export function folderProvider(): FolderProvider | undefined {
  return provider;
}
