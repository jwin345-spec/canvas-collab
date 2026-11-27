import {
  type CompactionResult,
  type DocumentStore,
  type StoredRoom,
  mergeIntoSnapshot,
  totalBytes,
} from './types';

/** Volatile store for tests and throwaway deployments. */
export class MemoryStore implements DocumentStore {
  readonly kind = 'memory';
  private readonly rooms = new Map<string, StoredRoom>();

  private room(roomId: string): StoredRoom {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { snapshot: null, updates: [] };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  async load(roomId: string): Promise<StoredRoom> {
    const room = this.rooms.get(roomId);
    return { snapshot: room?.snapshot ?? null, updates: [...(room?.updates ?? [])] };
  }

  async append(roomId: string, update: Uint8Array): Promise<void> {
    this.room(roomId).updates.push(update);
  }

  async compact(roomId: string, state?: Uint8Array): Promise<CompactionResult | null> {
    const room = this.room(roomId);
    if (!state && room.updates.length === 0) return null;
    const bytesBefore = totalBytes([room.snapshot, ...room.updates]);
    const snapshot = state ?? mergeIntoSnapshot(room.snapshot, room.updates);
    const updatesCompacted = room.updates.length;
    this.rooms.set(roomId, { snapshot, updates: [] });
    return { updatesCompacted, bytesBefore, bytesAfter: snapshot.byteLength };
  }

  async close(): Promise<void> {
    this.rooms.clear();
  }
}
