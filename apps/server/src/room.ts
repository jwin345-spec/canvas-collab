import {
  type AwarenessChange,
  CloseCode,
  MessageType,
  changedClients,
  decodeFrame,
  encodeAwarenessUpdate,
  encodeSyncStep1,
  encodeUpdate,
  handleAwarenessPayload,
  handleSyncPayload,
} from '@canvas-collab/shared';
import { Awareness, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { Connection } from './connection';
import type { Logger } from './logger';
import type { CompactionResult, DocumentStore } from './persistence';

/** Origin for transactions replayed from storage: they must not be re-persisted. */
const PERSISTENCE_ORIGIN = Symbol('persistence');

export interface RoomOptions {
  store: DocumentStore;
  logger: Logger;
  /** Compact once this many updates have been appended since the last snapshot. */
  compactionThreshold: number;
  /** Invoked when the last connection leaves. */
  onEmpty?: (room: Room) => void;
}

/**
 * Authoritative replica of one board. Relays updates between connections, persists every
 * update to the store's append log, and folds the log into a snapshot when it grows.
 *
 * All store writes are chained through `persistQueue`, so the store sees appends and
 * compactions in exactly the order the doc produced them.
 */
export class Room {
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness = new Awareness(this.doc);
  private readonly connections = new Map<Connection, Set<number>>();
  private readonly logger: Logger;
  private persistQueue: Promise<unknown> = Promise.resolve();
  private updatesSinceSnapshot = 0;
  private compacting: Promise<CompactionResult | null> | null = null;
  private destroyed = false;

  private constructor(
    readonly id: string,
    private readonly options: RoomOptions,
  ) {
    this.logger = options.logger.child({ roomId: id });
    // The server is a relay, not a participant: it publishes no presence of its own.
    this.awareness.setLocalState(null);
    this.doc.on('update', this.handleDocUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);
  }

  static async load(id: string, options: RoomOptions): Promise<Room> {
    const room = new Room(id, options);
    const started = performance.now();
    const { snapshot, updates } = await options.store.load(id);
    room.doc.transact(() => {
      if (snapshot) Y.applyUpdate(room.doc, snapshot);
      for (const update of updates) Y.applyUpdate(room.doc, update);
    }, PERSISTENCE_ORIGIN);
    room.updatesSinceSnapshot = updates.length;
    room.logger.info(
      {
        snapshotBytes: snapshot?.byteLength ?? 0,
        logEntries: updates.length,
        ms: Math.round(performance.now() - started),
      },
      'room loaded',
    );
    if (updates.length >= options.compactionThreshold) void room.compact();
    return room;
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get hasUncompactedUpdates(): boolean {
    return this.updatesSinceSnapshot > 0;
  }

  addConnection(conn: Connection): void {
    this.connections.set(conn, new Set());
    conn.onClose(() => this.removeConnection(conn));
    conn.setMessageHandler((data) => this.handleMessage(conn, data));

    // Server-initiated step1: the client answers with everything we are missing, which is
    // how edits made while the client was offline reach the server.
    conn.send(encodeSyncStep1(this.doc));
    const states = [...this.awareness.getStates().keys()];
    if (states.length > 0) conn.send(encodeAwarenessUpdate(this.awareness, states));
    this.logger.debug({ connId: conn.id, connections: this.connections.size }, 'client joined');
  }

  private removeConnection(conn: Connection): void {
    const clientIds = this.connections.get(conn);
    if (!clientIds) return;
    this.connections.delete(conn);
    // Clear the presence this socket owned immediately rather than waiting for the
    // 30s awareness timeout, so cursors vanish as soon as someone leaves.
    removeAwarenessStates(this.awareness, [...clientIds], null);
    this.logger.debug({ connId: conn.id, connections: this.connections.size }, 'client left');
    if (this.connections.size === 0 && !this.destroyed) this.options.onEmpty?.(this);
  }

  private handleMessage(conn: Connection, data: Uint8Array): void {
    try {
      const { type, decoder } = decodeFrame(data);
      switch (type) {
        case MessageType.Sync: {
          const result = handleSyncPayload(decoder, this.doc, conn, { readOnly: conn.readOnly });
          if (result.reply) conn.send(result.reply);
          if (result.rejected) conn.logger.debug('dropped write from read-only client');
          break;
        }
        case MessageType.Awareness:
          handleAwarenessPayload(decoder, this.awareness, conn);
          break;
        case MessageType.QueryAwareness:
          conn.send(encodeAwarenessUpdate(this.awareness, [...this.awareness.getStates().keys()]));
          break;
        default:
          conn.logger.debug({ type }, 'ignoring unknown message type');
      }
    } catch (error) {
      conn.logger.warn({ err: error }, 'malformed message, closing connection');
      conn.close(CloseCode.InvalidPayload, 'malformed message');
    }
  }

  private readonly handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === PERSISTENCE_ORIGIN) return;

    const frame = encodeUpdate(update);
    for (const conn of this.connections.keys()) {
      if (conn !== origin) conn.send(frame);
    }

    this.updatesSinceSnapshot++;
    this.enqueue(() => this.options.store.append(this.id, update)).catch((error: unknown) => {
      // The update is still in memory and will be captured by the next compaction,
      // which snapshots the full in-memory state.
      this.logger.error({ err: error }, 'failed to persist update');
    });
    if (this.updatesSinceSnapshot >= this.options.compactionThreshold) void this.compact();
  };

  private readonly handleAwarenessUpdate = (change: AwarenessChange, origin: unknown): void => {
    const changed = changedClients(change);
    const owner = origin instanceof Connection ? this.connections.get(origin) : undefined;
    if (owner) {
      for (const clientId of change.added) owner.add(clientId);
      for (const clientId of change.removed) owner.delete(clientId);
    }
    // Echo to the sender too: periodic awareness renewals double as its liveness signal.
    const frame = encodeAwarenessUpdate(this.awareness, changed);
    for (const conn of this.connections.keys()) conn.send(frame);
  };

  /** Folds the update log into a snapshot of the current in-memory state. */
  compact(): Promise<CompactionResult | null> {
    if (this.compacting) return this.compacting;
    const pendingAtStart = this.updatesSinceSnapshot;
    this.compacting = this.enqueue(async () => {
      // Encoded inside the queue: every append ahead of us has landed, so the snapshot is
      // a superset of the log it replaces.
      const state = Y.encodeStateAsUpdate(this.doc);
      const result = await this.options.store.compact(this.id, state);
      this.updatesSinceSnapshot = Math.max(0, this.updatesSinceSnapshot - pendingAtStart);
      if (result) this.logger.info(result, 'room compacted');
      return result;
    })
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'compaction failed');
        return null;
      })
      .finally(() => {
        this.compacting = null;
        // Updates that arrived mid-compaction may already have crossed the threshold again.
        if (!this.destroyed && this.updatesSinceSnapshot >= this.options.compactionThreshold) {
          void this.compact();
        }
      });
    return this.compacting;
  }

  /** Resolves once every queued store write has settled. */
  async flush(): Promise<void> {
    await this.persistQueue;
  }

  closeConnections(code: number, reason: string): void {
    for (const conn of this.connections.keys()) conn.close(code, reason);
  }

  destroy(): void {
    this.destroyed = true;
    this.doc.off('update', this.handleDocUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);
    this.awareness.destroy();
    this.doc.destroy();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.persistQueue.then(task, task);
    this.persistQueue = next.catch(() => undefined);
    return next;
  }
}
