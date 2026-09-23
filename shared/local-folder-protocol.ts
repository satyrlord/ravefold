export const LOCAL_FOLDER_ENDPOINT = "/__ravefold_local/files";
export const LOCAL_FOLDER_HEADER = "x-ravefold-local";
export const LOCAL_CHUNK_BYTES = 256 * 1024;

export interface LocalHandle {
  id: string;
  kind: "file" | "directory";
  name: string;
}

export interface LocalFileInfo {
  size: number;
  lastModified: number;
  version: string;
}

export type LocalRequest =
  | { op: "roots" }
  | { op: "permission"; handle: string }
  | {
      op: "child";
      handle: string;
      name: string;
      kind: "file" | "directory";
      create?: boolean;
    }
  | { op: "entries"; handle: string }
  | { op: "resolve" | "same"; handle: string; other: string }
  | { op: "file"; handle: string }
  | {
      op: "read";
      handle: string;
      version: string;
      offset: number;
      length: number;
    }
  | { op: "writable"; handle: string }
  | { op: "write"; writer: string; data: string }
  | { op: "close" | "abort"; writer: string }
  | { op: "remove"; handle: string; name: string };

export type LocalResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string } };
