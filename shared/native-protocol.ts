export const NATIVE_CHANNEL = "ravefold-native";
export const NATIVE_VERSION = 1;
export const MAX_READ_BYTES = 262_144;

export type NativeRole = "samples" | "settings";
export interface NativeHandle {
  id: string;
  name: string;
  kind: "directory" | "file";
}
export interface NativeFileInfo {
  name: string;
  size: number;
  lastModified: number;
  version: string;
}
export type NativeOperation =
  | { op: "permission"; handle: string }
  | {
      op: "getFile" | "getDirectory";
      handle: string;
      name: string;
      create?: boolean;
    }
  | { op: "list"; handle: string; cursor?: string; limit?: number }
  | { op: "closeList"; cursor: string }
  | { op: "stat"; handle: string }
  | {
      op: "read";
      handle: string;
      version: string;
      offset: number;
      length: number;
    }
  | { op: "same" | "resolve"; handle: string; other: string }
  | { op: "openWriter"; handle: string }
  | { op: "write"; writer: string; data: string }
  | { op: "closeWriter" | "abortWriter"; writer: string }
  | { op: "remove"; handle: string; name: string };
export type HostOperation =
  | { op: "pickFolder"; kind: NativeRole }
  | { op: "loadReferences" }
  | { op: "saveReference"; kind: NativeRole; handle: string };
export interface NativeRequest {
  channel: typeof NATIVE_CHANNEL;
  version: typeof NATIVE_VERSION;
  id: string;
  request: NativeOperation | HostOperation;
}
export type NativeResponse = {
  channel: typeof NATIVE_CHANNEL;
  version: typeof NATIVE_VERSION;
  id: string;
} & (
  | { ok: true; result: unknown }
  | { ok: false; error: { name: string; message: string } }
);
export interface NativeRevocation {
  channel: typeof NATIVE_CHANNEL;
  version: typeof NATIVE_VERSION;
  event: "revoked";
}

export function isNativeRequest(value: unknown): value is NativeRequest {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    data.channel === NATIVE_CHANNEL &&
    data.version === NATIVE_VERSION &&
    typeof data.id === "string" &&
    /^[a-zA-Z0-9_-]{1,80}$/.test(data.id) &&
    typeof data.request === "object" &&
    data.request !== null &&
    !Array.isArray(data.request) &&
    typeof (data.request as Record<string, unknown>).op === "string"
  );
}
