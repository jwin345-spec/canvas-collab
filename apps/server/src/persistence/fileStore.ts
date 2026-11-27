import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CompactionResult,
  type DocumentStore,
  type StoredRoom,
  mergeIntoSnapshot,
  totalBytes,
} from './types';

const SNAPSHOT_FILE = 'snapshot.bin';
const LOG_FILE = 'updates.log';
const HEADER_BYTES = 4;

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Encodes one log record: uint32le length prefix followed by the update bytes. */
export function encodeRecord(update: Uint8Array): Buffer {
  const record = Buffer.allocUnsafe(HEADER_BYTES + update.byteLength);
  record.writeUInt32LE(update.byteLength, 0);
  record.set(update, HEADER_BYTES);
  return record;
}

/**
 * Decodes a log. A torn trailing record (process killed mid-append) is ignored rather than
 * treated as corruption: every complete record before it is still valid.
 */
export function decodeLog(log: Buffer): Uint8Array[] {
  const updates: Uint8Array[] = [];
  let offset = 0;
  while (offset + HEADER_BYTES <= log.byteLength) {
    const length = log.readUInt32LE(offset);
    const end = offset + HEADER_BYTES + length;
    if (end > log.byteLength) break;
    updates.push(new Uint8Array(log.subarray(offset + HEADER_BYTES, end)));
    offset = end;
  }
  return updates;
}

/**
 * Dependency-free fallback for machines where the better-sqlite3 native build is
 * unavailable. Layout: `<dataDir>/rooms/<roomId>/{snapshot.bin,updates.log}`.
 *
 * Room ids are validated against `[A-Za-z0-9_-]{1,64}` before they reach the store, so
 * they are safe to use as directory names. Operations on one room are serialised through
 * a per-room promise chain so compaction never races an append.
 */
export class FileStore implements DocumentStore {
  readonly kind = 'file';
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly dataDir: string) {}

  private roomDir(roomId: string): string {
    return join(this.dataDir, 'rooms', roomId);
  }

  private withLock<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(roomId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    this.locks.set(roomId, settled);
    void settled.then(() => {
      if (this.locks.get(roomId) === settled) this.locks.delete(roomId);
    });
    return next;
  }

  load(roomId: string): Promise<StoredRoom> {
    return this.withLock(roomId, async () => {
      const dir = this.roomDir(roomId);
      const [snapshot, log] = await Promise.all([
        readOptional(join(dir, SNAPSHOT_FILE)),
        readOptional(join(dir, LOG_FILE)),
      ]);
      return {
        snapshot: snapshot ? new Uint8Array(snapshot) : null,
        updates: log ? decodeLog(log) : [],
      };
    });
  }

  append(roomId: string, update: Uint8Array): Promise<void> {
    return this.withLock(roomId, async () => {
      const dir = this.roomDir(roomId);
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, LOG_FILE), encodeRecord(update));
    });
  }

  compact(roomId: string, state?: Uint8Array): Promise<CompactionResult | null> {
    return this.withLock(roomId, async () => {
      const dir = this.roomDir(roomId);
      const previous = await readOptional(join(dir, SNAPSHOT_FILE));
      const log = await readOptional(join(dir, LOG_FILE));
      const updates = log ? decodeLog(log) : [];
      if (!state && updates.length === 0) return null;

      const snapshot = state ?? mergeIntoSnapshot(previous, updates);
      await mkdir(dir, { recursive: true });
      // Write-then-rename makes the snapshot swap atomic. A crash after the rename but
      // before the log is removed only means some updates are replayed twice on load,
      // which Yjs treats as a no-op.
      const tmp = join(dir, `${SNAPSHOT_FILE}.tmp`);
      await writeFile(tmp, snapshot);
      await rename(tmp, join(dir, SNAPSHOT_FILE));
      await rm(join(dir, LOG_FILE), { force: true });
      return {
        updatesCompacted: updates.length,
        bytesBefore: totalBytes([previous, log]),
        bytesAfter: snapshot.byteLength,
      };
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.locks.values());
  }
}
