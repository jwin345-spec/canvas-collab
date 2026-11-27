import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import {
  type CompactionResult,
  type DocumentStore,
  type StoredRoom,
  mergeIntoSnapshot,
  totalBytes,
} from './types';

interface UpdateRow {
  id: number;
  data: Buffer;
}

interface SnapshotRow {
  data: Buffer;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS snapshots (
    room       TEXT    PRIMARY KEY,
    data       BLOB    NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS updates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    room       TEXT    NOT NULL,
    data       BLOB    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS updates_room_id ON updates (room, id);
`;

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * SQLite-backed store (better-sqlite3, WAL mode). better-sqlite3 is synchronous, which is
 * the right call for a single-process server: each statement is microseconds, avoids the
 * thread-pool hop of async drivers, and gives us real transactions for compaction.
 */
export class SqliteStore implements DocumentStore {
  readonly kind = 'sqlite';
  private readonly statements;

  private constructor(private readonly db: BetterSqlite3.Database) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    this.statements = {
      snapshot: db.prepare<[string], SnapshotRow>('SELECT data FROM snapshots WHERE room = ?'),
      updates: db.prepare<[string], UpdateRow>(
        'SELECT id, data FROM updates WHERE room = ? ORDER BY id',
      ),
      append: db.prepare<[string, Buffer, number]>(
        'INSERT INTO updates (room, data, created_at) VALUES (?, ?, ?)',
      ),
      upsertSnapshot: db.prepare<[string, Buffer, number]>(
        `INSERT INTO snapshots (room, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (room) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      ),
      truncate: db.prepare<[string, number]>('DELETE FROM updates WHERE room = ? AND id <= ?'),
    };
  }

  /**
   * Opens (creating if needed) the database. The native module is imported lazily so a
   * missing or broken build surfaces here, where the caller can fall back to another store.
   */
  static async open(file: string): Promise<SqliteStore> {
    const { default: Database } = await import('better-sqlite3');
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    return new SqliteStore(new Database(file));
  }

  async load(roomId: string): Promise<StoredRoom> {
    const snapshot = this.statements.snapshot.get(roomId);
    const updates = this.statements.updates.all(roomId);
    return {
      snapshot: snapshot ? new Uint8Array(snapshot.data) : null,
      updates: updates.map((row) => new Uint8Array(row.data)),
    };
  }

  async append(roomId: string, update: Uint8Array): Promise<void> {
    this.statements.append.run(roomId, toBuffer(update), Date.now());
  }

  async compact(roomId: string, state?: Uint8Array): Promise<CompactionResult | null> {
    const run = this.db.transaction((): CompactionResult | null => {
      const previous = this.statements.snapshot.get(roomId)?.data ?? null;
      const rows = this.statements.updates.all(roomId);
      if (!state && rows.length === 0) return null;

      const snapshot =
        state ??
        mergeIntoSnapshot(
          previous,
          rows.map((row) => row.data),
        );
      this.statements.upsertSnapshot.run(roomId, toBuffer(snapshot), Date.now());
      const lastId = rows.at(-1)?.id;
      if (lastId !== undefined) this.statements.truncate.run(roomId, lastId);
      return {
        updatesCompacted: rows.length,
        bytesBefore: totalBytes([previous, ...rows.map((row) => row.data)]),
        bytesAfter: snapshot.byteLength,
      };
    });
    // IMMEDIATE takes the write lock up front so the read-then-write cannot interleave.
    return run.immediate();
  }

  async close(): Promise<void> {
    if (this.db.open) this.db.close();
  }
}
