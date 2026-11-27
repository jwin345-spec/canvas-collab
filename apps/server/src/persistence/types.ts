import * as Y from 'yjs';

export interface StoredRoom {
  /** Compacted state of the room, or null if it has never been compacted. */
  snapshot: Uint8Array | null;
  /** Incremental updates appended since the snapshot, in append order. */
  updates: Uint8Array[];
}

export interface CompactionResult {
  /** Number of log entries folded into the snapshot. */
  updatesCompacted: number;
  bytesBefore: number;
  bytesAfter: number;
}

/**
 * Append-only document store with snapshot compaction.
 *
 * The write path is a cheap append of each incremental Yjs update. Loading replays the
 * snapshot plus the log. Compaction folds the log into a fresh snapshot so load time and
 * disk usage stay bounded. Because Yjs updates are idempotent and commutative, replaying an
 * update that is already part of the snapshot is harmless, which is what makes the crash
 * windows in the implementations below safe.
 */
export interface DocumentStore {
  readonly kind: 'sqlite' | 'file' | 'memory';
  load(roomId: string): Promise<StoredRoom>;
  append(roomId: string, update: Uint8Array): Promise<void>;
  /**
   * Replaces the snapshot and truncates the log.
   *
   * With `state`, that state becomes the snapshot; the caller guarantees it is a superset of
   * every logged update (the in-memory doc always is). Without it, the store merges its
   * own snapshot and log. Returns null when there was nothing to compact.
   */
  compact(roomId: string, state?: Uint8Array): Promise<CompactionResult | null>;
  close(): Promise<void>;
}

/**
 * Folds updates into one garbage-collected state update. Applying to a real Y.Doc (instead
 * of `Y.mergeUpdates`) lets Yjs drop the content of deleted items, which is where most of
 * the space savings come from on a busy board.
 */
export function mergeIntoSnapshot(snapshot: Uint8Array | null, updates: Uint8Array[]): Uint8Array {
  const doc = new Y.Doc({ gc: true });
  try {
    doc.transact(() => {
      if (snapshot) Y.applyUpdate(doc, snapshot);
      for (const update of updates) Y.applyUpdate(doc, update);
    });
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

export function totalBytes(chunks: readonly (Uint8Array | null)[]): number {
  return chunks.reduce((sum, chunk) => sum + (chunk?.byteLength ?? 0), 0);
}
