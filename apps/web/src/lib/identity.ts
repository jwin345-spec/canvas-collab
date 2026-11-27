import { RoomIdSchema, colorForUser, createId, type PresenceUser } from '@canvas-collab/shared';

const ADJECTIVES = ['Swift', 'Calm', 'Bright', 'Bold', 'Keen', 'Lucky', 'Quiet', 'Witty'];
const ANIMALS = ['Otter', 'Falcon', 'Lynx', 'Heron', 'Panda', 'Koala', 'Fox', 'Orca'];
const IDENTITY_KEY = 'canvas-collab:identity';

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T;
}

function readStorage(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Storage may be unavailable (private mode, sandboxed iframe); identity is then per load.
  }
}

/**
 * Anonymous demo identity. Kept in sessionStorage so each tab is a distinct participant,
 * which is what you want when demoing multiplayer from one browser.
 */
export function loadIdentity(storage: Storage = window.sessionStorage): PresenceUser {
  const stored = readStorage(storage, IDENTITY_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<PresenceUser>;
      if (typeof parsed.id === 'string' && typeof parsed.name === 'string') {
        return { id: parsed.id, name: parsed.name, color: colorForUser(parsed.id) };
      }
    } catch {
      // Fall through and mint a fresh identity.
    }
  }
  const id = createId();
  const identity = { id, name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: colorForUser(id) };
  writeStorage(storage, IDENTITY_KEY, JSON.stringify({ id, name: identity.name }));
  return identity;
}

/** Reads `?room=` from the URL, creating (and writing back) a fresh room id if absent. */
export function resolveRoomId(location: Location = window.location): string {
  const url = new URL(location.href);
  const requested = url.searchParams.get('room');
  if (requested && RoomIdSchema.safeParse(requested).success) return requested;
  const roomId = createId().slice(0, 10);
  url.searchParams.set('room', roomId);
  window.history.replaceState(null, '', url);
  return roomId;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
