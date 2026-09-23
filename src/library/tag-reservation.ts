import {
  MAX_TAG_RESERVATION_BYTES,
  parseTagReservation,
  tagReservationName,
  TAG_RESERVATION_PATTERN,
  TAG_RESERVATION_BUSY_MESSAGE,
  type TagReservationRecord,
} from "../domain/tag-reservation.ts";
import {
  checkAbort,
  isNamedError,
  type DirectoryHandle,
  type FileHandle,
} from "../storage/handles.ts";

interface ReservationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function busy(): Error {
  return new Error(TAG_RESERVATION_BUSY_MESSAGE);
}

interface PendingCleanup {
  root: DirectoryHandle;
  handle: FileHandle;
  name: string;
  expected: string;
}
const pendingCleanup = new Set<PendingCleanup>();

async function cleanOwnedRegister(
  record: PendingCleanup,
  root = record.root,
): Promise<boolean> {
  try {
    const current = await root.getFileHandle(record.name);
    const file = await current.getFile();
    if (
      !(await current.isSameEntry(record.handle)) ||
      file.size > MAX_TAG_RESERVATION_BYTES ||
      (await file.text()) !== record.expected
    )
      return true;
    await root.removeEntry(record.name);
    return true;
  } catch (error) {
    return isNamedError(error, "NotFoundError");
  }
}

async function retryOwnCleanup(
  root: DirectoryHandle,
  signal?: AbortSignal,
): Promise<void> {
  for (const record of pendingCleanup) {
    checkAbort(signal);
    let same = record.root === root;
    try {
      same ||= await record.root.isSameEntry(root);
    } catch {
      continue;
    }
    if (same && (await cleanOwnedRegister(record, root)))
      pendingCleanup.delete(record);
  }
}

async function participants(
  root: DirectoryHandle,
  signal?: AbortSignal,
): Promise<TagReservationRecord[]> {
  const rows: TagReservationRecord[] = [];
  for await (const [name, handle] of root.entries()) {
    checkAbort(signal);
    const owner = TAG_RESERVATION_PATTERN.exec(name)?.[1];
    if (!owner) continue;
    if (handle.kind !== "file" || rows.length >= 256) throw busy();
    try {
      const file = await handle.getFile();
      if (file.size > MAX_TAG_RESERVATION_BYTES) throw busy();
      const source = await file.text();
      rows.push(
        source === ""
          ? { schemaVersion: 1, owner, choosing: true, ticket: 0 }
          : parseTagReservation(source, name),
      );
    } catch (error) {
      if (isNamedError(error, "NotFoundError")) continue;
      if (
        isNamedError(error, "InvalidStateError") ||
        isNamedError(error, "NotReadableError")
      )
        rows.push({ schemaVersion: 1, owner, choosing: true, ticket: 0 });
      else throw error;
    }
  }
  return rows;
}

async function pause(signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, 20);
    signal?.addEventListener("abort", aborted, { once: true });
  });
  checkAbort(signal);
}

/** Each writer owns one register. See docs/tag-write-protocol.md for the proof. */
export async function withTagReservation<T>(
  root: DirectoryHandle,
  operation: (assertOwned: () => Promise<void>) => Promise<T>,
  options: ReservationOptions = {},
): Promise<T> {
  checkAbort(options.signal);
  await retryOwnCleanup(root, options.signal);
  const owner = crypto.randomUUID();
  const name = tagReservationName(owner);
  try {
    await root.getFileHandle(name);
    throw busy();
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
  }
  const handle = await root.getFileHandle(name, { create: true });
  let expected = "";
  let published = false;
  const deadline = Date.now() + (options.timeoutMs ?? 3_000);
  const assertOwned = async () => {
    checkAbort(options.signal);
    const current = published ? await root.getFileHandle(name) : handle;
    if (!(await current.isSameEntry(handle))) throw busy();
    const file = await current.getFile();
    if (
      file.size > MAX_TAG_RESERVATION_BYTES ||
      (await file.text()) !== expected
    )
      throw busy();
  };
  const publish = async (record: TagReservationRecord) => {
    await assertOwned();
    const text = JSON.stringify(record) + "\n";
    const writer = await handle.createWritable({ mode: "exclusive" });
    let closed = false;
    try {
      await assertOwned();
      await writer.write(text);
      checkAbort(options.signal);
      await writer.close();
      closed = true;
      expected = text;
      published = true;
    } finally {
      if (!closed) await writer.abort().catch(() => undefined);
    }
  };
  try {
    await publish({ schemaVersion: 1, owner, choosing: true, ticket: 0 });
    const rows = await participants(root, options.signal);
    const maximum = rows.reduce((value, row) => Math.max(value, row.ticket), 0);
    if (maximum >= Number.MAX_SAFE_INTEGER) throw busy();
    const ticket = maximum + 1;
    await publish({ schemaVersion: 1, owner, choosing: false, ticket });
    for (;;) {
      const current = await participants(root, options.signal);
      const blocked = current.some(
        (row) =>
          row.owner !== owner &&
          (row.choosing ||
            row.ticket < ticket ||
            (row.ticket === ticket && row.owner < owner)),
      );
      if (!blocked) {
        await assertOwned();
        return await operation(assertOwned);
      }
      if (Date.now() >= deadline) throw busy();
      await pause(options.signal);
    }
  } finally {
    const record = { root, handle, name, expected };
    if (!(await cleanOwnedRegister(record))) pendingCleanup.add(record);
  }
}
