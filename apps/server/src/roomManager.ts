import { CloseCode } from '@canvas-collab/shared';
import type { Connection } from './connection';
import type { Logger } from './logger';
import type { DocumentStore } from './persistence';
import { Room } from './room';

export interface RoomManagerOptions {
  store: DocumentStore;
  logger: Logger;
  compactionThreshold: number;
  compactionIntervalMs: number;
  /** How long an empty room stays in memory before it is compacted and unloaded. */
  idleTtlMs: number;
}

/**
 * Owns the lifecycle of in-memory rooms: lazy loading (deduplicated, so two clients racing
 * into a cold room share one load), periodic compaction, idle eviction and shutdown.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly loading = new Map<string, Promise<Room>>();
  private readonly evicting = new Map<string, Promise<void>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private compactionTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RoomManagerOptions) {}

  get roomCount(): number {
    return this.rooms.size;
  }

  get connectionCount(): number {
    let total = 0;
    for (const room of this.rooms.values()) total += room.connectionCount;
    return total;
  }

  getLoadedRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** Adds `conn` to the room, loading the room first if it is not in memory. */
  async join(roomId: string, conn: Connection): Promise<Room> {
    const room = await this.acquire(roomId);
    if (conn.isOpen) {
      this.cancelEviction(roomId);
      room.addConnection(conn);
    } else if (room.connectionCount === 0) {
      // The client gave up while the room was loading.
      this.scheduleEviction(room);
    }
    return room;
  }

  startCompactionLoop(): void {
    this.compactionTimer ??= setInterval(() => {
      for (const room of this.rooms.values()) {
        if (room.hasUncompactedUpdates) void room.compact();
      }
    }, this.options.compactionIntervalMs);
    this.compactionTimer.unref();
  }

  /** Disconnects everyone, persists a final snapshot of every room and unloads it. */
  async shutdown(): Promise<void> {
    if (this.compactionTimer) clearInterval(this.compactionTimer);
    this.compactionTimer = null;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();

    await Promise.allSettled([...this.loading.values(), ...this.evicting.values()]);
    const rooms = [...this.rooms.values()];
    for (const room of rooms) room.closeConnections(CloseCode.GoingAway, 'server shutting down');
    await Promise.allSettled(rooms.map((room) => this.unload(room)));
  }

  private async acquire(roomId: string): Promise<Room> {
    const eviction = this.evicting.get(roomId);
    if (eviction) await eviction;

    const loaded = this.rooms.get(roomId);
    if (loaded) return loaded;

    let pending = this.loading.get(roomId);
    if (!pending) {
      pending = Room.load(roomId, {
        store: this.options.store,
        logger: this.options.logger,
        compactionThreshold: this.options.compactionThreshold,
        onEmpty: (room) => this.scheduleEviction(room),
      })
        .then((room) => {
          this.rooms.set(roomId, room);
          return room;
        })
        .finally(() => this.loading.delete(roomId));
      this.loading.set(roomId, pending);
    }
    return pending;
  }

  private scheduleEviction(room: Room): void {
    this.cancelEviction(room.id);
    const timer = setTimeout(() => {
      this.idleTimers.delete(room.id);
      if (room.connectionCount > 0 || this.rooms.get(room.id) !== room) return;
      const eviction = this.unload(room).finally(() => this.evicting.delete(room.id));
      this.evicting.set(room.id, eviction);
    }, this.options.idleTtlMs);
    timer.unref();
    this.idleTimers.set(room.id, timer);
  }

  private cancelEviction(roomId: string): void {
    const timer = this.idleTimers.get(roomId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(roomId);
  }

  private async unload(room: Room): Promise<void> {
    try {
      if (room.hasUncompactedUpdates) await room.compact();
      await room.flush();
    } finally {
      this.rooms.delete(room.id);
      room.destroy();
      this.options.logger.info({ roomId: room.id }, 'room unloaded');
    }
  }
}
