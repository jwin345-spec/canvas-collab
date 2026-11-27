import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addShape, makeBoxShape, readShapes, updateShape } from '@canvas-collab/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createStore,
  type DocumentStore,
  FileStore,
  MemoryStore,
  SqliteStore,
} from '../src/persistence';
import { decodeLog, encodeRecord } from '../src/persistence/fileStore';
import { silentLogger } from './helpers';

const sqliteAvailable = await SqliteStore.open(':memory:').then(
  async (store) => {
    await store.close();
    return true;
  },
  () => false,
);

/** Records every incremental update a doc produces, like the server's append path does. */
function recordingDoc() {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  return { doc, updates };
}

function restore(snapshot: Uint8Array | null, updates: Uint8Array[]): Y.Doc {
  const doc = new Y.Doc();
  if (snapshot) Y.applyUpdate(doc, snapshot);
  for (const update of updates) Y.applyUpdate(doc, update);
  return doc;
}

function busyBoard() {
  const { doc, updates } = recordingDoc();
  const note = makeBoxShape('sticky', { x: 0, y: 0 }, { createdBy: 'u', zIndex: 1 });
  addShape(doc, note);
  for (let i = 0; i < 50; i++) updateShape(doc, note.id, { x: i, text: `edit ${i}` });
  return { doc, updates };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canvas-collab-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const factories: [string, () => Promise<DocumentStore>, boolean][] = [
  ['MemoryStore', async () => new MemoryStore(), true],
  ['FileStore', async () => new FileStore(dir), true],
  ['SqliteStore', () => SqliteStore.open(join(dir, 'test.db')), sqliteAvailable],
];

describe.each(factories)('%s', (_name, open, available) => {
  let store: DocumentStore;
  beforeEach(async () => {
    if (available) store = await open();
  });
  afterEach(async () => {
    if (available) await store.close();
  });

  it.runIf(available)('returns an empty room for unknown ids', async () => {
    await expect(store.load('nope')).resolves.toEqual({ snapshot: null, updates: [] });
  });

  it.runIf(available)('appends updates in order and isolates rooms', async () => {
    const { doc, updates } = busyBoard();
    for (const update of updates) await store.append('a', update);
    await store.append('b', updates[0]!);

    const loaded = await store.load('a');
    expect(loaded.snapshot).toBeNull();
    expect(loaded.updates).toHaveLength(updates.length);
    expect(readShapes(restore(null, loaded.updates))).toEqual(readShapes(doc));
    expect((await store.load('b')).updates).toHaveLength(1);
  });

  it.runIf(available)('compacts the log into a smaller snapshot', async () => {
    const { doc, updates } = busyBoard();
    for (const update of updates) await store.append('room', update);

    const result = await store.compact('room');
    expect(result).toMatchObject({ updatesCompacted: updates.length });
    expect(result!.bytesAfter).toBeLessThan(result!.bytesBefore);

    const loaded = await store.load('room');
    expect(loaded.updates).toEqual([]);
    expect(readShapes(restore(loaded.snapshot, []))).toEqual(readShapes(doc));
  });

  it.runIf(available)('keeps appending after compaction', async () => {
    const { doc, updates } = busyBoard();
    for (const update of updates.slice(0, 10)) await store.append('room', update);
    await store.compact('room');
    for (const update of updates.slice(10)) await store.append('room', update);

    const loaded = await store.load('room');
    expect(loaded.updates).toHaveLength(updates.length - 10);
    expect(readShapes(restore(loaded.snapshot, loaded.updates))).toEqual(readShapes(doc));
    await store.compact('room');
    expect(readShapes(restore((await store.load('room')).snapshot, []))).toEqual(readShapes(doc));
  });

  it.runIf(available)('uses a supplied state as the snapshot', async () => {
    const { doc, updates } = busyBoard();
    await store.append('room', updates[0]!);
    await store.compact('room', Y.encodeStateAsUpdate(doc));
    const loaded = await store.load('room');
    expect(loaded.updates).toEqual([]);
    expect(readShapes(restore(loaded.snapshot, []))).toEqual(readShapes(doc));
  });

  it.runIf(available)('has nothing to compact on an empty log', async () => {
    await expect(store.compact('room')).resolves.toBeNull();
  });
});

describe('FileStore log format', () => {
  it('round-trips records and ignores a torn trailing write', async () => {
    const records = [new Uint8Array([1, 2, 3]), new Uint8Array([]), new Uint8Array([9])];
    const log = Buffer.concat(records.map(encodeRecord));
    expect(decodeLog(log)).toEqual(records);

    const torn = Buffer.concat([log, encodeRecord(new Uint8Array([7, 7, 7, 7])).subarray(0, 6)]);
    expect(decodeLog(torn)).toEqual(records);
  });

  it('recovers from a crash between snapshot swap and log removal', async () => {
    const store = new FileStore(dir);
    const { doc, updates } = busyBoard();
    for (const update of updates) await store.append('room', update);
    const logPath = join(dir, 'rooms', 'room', 'updates.log');
    const staleLog = await readFile(logPath);
    await store.compact('room');
    // Simulate the crash: the old log reappears next to the new snapshot.
    await writeFile(logPath, staleLog);

    const loaded = await store.load('room');
    expect(readShapes(restore(loaded.snapshot, loaded.updates))).toEqual(readShapes(doc));
  });
});

describe.runIf(sqliteAvailable)('SqliteStore durability', () => {
  it('persists across reopen', async () => {
    const file = join(dir, 'durable.db');
    const { doc, updates } = busyBoard();
    const first = await SqliteStore.open(file);
    for (const update of updates) await first.append('room', update);
    await first.compact('room');
    await first.append('room', updates[0]!);
    await first.close();

    const second = await SqliteStore.open(file);
    const loaded = await second.load('room');
    await second.close();
    expect(loaded.updates).toHaveLength(1);
    expect(readShapes(restore(loaded.snapshot, loaded.updates))).toEqual(readShapes(doc));
  });
});

describe('createStore', () => {
  it('builds the requested backend', async () => {
    const memory = await createStore({ persistence: 'memory', dataDir: dir }, silentLogger);
    expect(memory.kind).toBe('memory');
    const file = await createStore({ persistence: 'file', dataDir: dir }, silentLogger);
    expect(file.kind).toBe('file');
    const auto = await createStore({ persistence: 'auto', dataDir: dir }, silentLogger);
    expect(auto.kind).toBe(sqliteAvailable ? 'sqlite' : 'file');
    await Promise.all([memory.close(), file.close(), auto.close()]);
  });
});
