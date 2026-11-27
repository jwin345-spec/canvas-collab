import { request } from 'node:http';
import {
  HealthResponseSchema,
  type PresenceState,
  TokenResponseSchema,
  addShape,
  deleteShapes,
  getShape,
  makeBoxShape,
  readShapes,
  updateShape,
} from '@canvas-collab/shared';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MemoryStore } from '../src/persistence';
import { type TestServer, startTestServer, waitFor, waitForSynced } from './helpers';

let server: TestServer;
afterEach(async () => {
  await server?.close();
});

function sticky(createdBy: string, x = 0) {
  return makeBoxShape('sticky', { x, y: 0 }, { createdBy, zIndex: 1 });
}

function field(doc: Y.Doc, id: string, key: string): unknown {
  const shape = getShape(doc, id);
  return shape ? (shape as Record<string, unknown>)[key] : undefined;
}

const sameBoard = (a: Y.Doc, b: Y.Doc) =>
  JSON.stringify(readShapes(a)) === JSON.stringify(readShapes(b));

describe('two clients on one room', () => {
  it('converge on concurrent edits', async () => {
    server = await startTestServer();
    const alice = server.connect('board');
    const bob = server.connect('board');
    await Promise.all([waitForSynced(alice), waitForSynced(bob)]);

    const note = sticky('alice');
    addShape(alice.doc, note);
    await waitFor(() => getShape(bob.doc, note.id) !== null, { message: 'bob to see note' });

    // Concurrent, conflicting and non-conflicting edits from both sides.
    updateShape(alice.doc, note.id, { x: 100, text: 'alice' });
    updateShape(bob.doc, note.id, { y: 250, text: 'bob' });
    addShape(bob.doc, sticky('bob', 400));

    await waitFor(() => sameBoard(alice.doc, bob.doc) && readShapes(bob.doc).length === 2, {
      message: 'replicas to converge',
    });
    expect(getShape(alice.doc, note.id)).toMatchObject({ x: 100, y: 250 });
    expect(sameBoard(server.app.rooms.getLoadedRoom('board')!.doc, alice.doc)).toBe(true);
  });

  it('merges edits made while a client was offline', async () => {
    server = await startTestServer();
    const alice = server.connect('board');
    const bob = server.connect('board');
    await Promise.all([waitForSynced(alice), waitForSynced(bob)]);
    const note = sticky('alice');
    addShape(alice.doc, note);
    await waitFor(() => getShape(bob.doc, note.id) !== null);

    alice.disconnect();
    await waitFor(() => alice.status === 'disconnected');
    updateShape(alice.doc, note.id, { text: 'written offline' });
    addShape(alice.doc, sticky('alice', 300));
    deleteShapes(bob.doc, [note.id]);
    addShape(bob.doc, sticky('bob', 600));

    alice.connect();
    await waitForSynced(alice);
    await waitFor(() => sameBoard(alice.doc, bob.doc), { message: 'offline edits to merge' });
    // Bob's delete wins over Alice's offline field edit; both new notes survive.
    expect(getShape(alice.doc, note.id)).toBeNull();
    expect(readShapes(alice.doc)).toHaveLength(2);
  });

  it('propagates presence and clears it when a client leaves', async () => {
    server = await startTestServer();
    const alice = server.connect('board');
    const bob = server.connect('board');
    await Promise.all([waitForSynced(alice), waitForSynced(bob)]);

    const presence: PresenceState = {
      user: { id: 'alice', name: 'Alice', color: '#3b82f6' },
      cursor: { x: 10, y: 20 },
      selection: [],
    };
    alice.awareness.setLocalState(presence);
    await waitFor(() => bob.awareness.getStates().get(alice.doc.clientID) !== undefined, {
      message: 'presence to arrive',
    });
    expect(bob.awareness.getStates().get(alice.doc.clientID)).toEqual(presence);

    alice.destroy();
    await waitFor(() => !bob.awareness.getStates().has(alice.doc.clientID), {
      message: 'presence to be cleared',
    });
  });

  it('ignores writes from viewers but still syncs state to them', async () => {
    server = await startTestServer();
    const editor = server.connect('board');
    const viewer = server.connect('board', { role: 'viewer' });
    await Promise.all([waitForSynced(editor), waitForSynced(viewer)]);

    const note = sticky('editor');
    addShape(editor.doc, note);
    await waitFor(() => getShape(viewer.doc, note.id) !== null);

    addShape(viewer.doc, sticky('viewer', 500));
    updateShape(editor.doc, note.id, { text: 'barrier' });
    await waitFor(() => field(viewer.doc, note.id, 'text') === 'barrier', {
      message: 'editor change to reach viewer',
    });
    expect(readShapes(editor.doc)).toHaveLength(1);
    expect(readShapes(server.app.rooms.getLoadedRoom('board')!.doc)).toHaveLength(1);
  });
});

describe('persistence through the server', () => {
  it('compacts after the threshold and restores rooms after eviction', async () => {
    const store = new MemoryStore();
    server = await startTestServer({ compactionUpdateThreshold: 10, roomIdleTtlMs: 0 }, store);
    const alice = server.connect('board');
    await waitForSynced(alice);
    const note = sticky('alice');
    addShape(alice.doc, note);
    for (let i = 1; i <= 25; i++) updateShape(alice.doc, note.id, { x: i });

    const room = server.app.rooms.getLoadedRoom('board')!;
    await waitFor(() => field(room.doc, note.id, 'x') === 25, { message: 'server to apply edits' });
    await room.flush();
    const stored = await store.load('board');
    expect(stored.snapshot).not.toBeNull();
    // 26 updates were sent; the threshold of 10 must have folded most of them away.
    expect(stored.updates.length).toBeLessThan(26);

    alice.destroy();
    await waitFor(() => server.app.rooms.getLoadedRoom('board') === undefined, {
      message: 'room eviction',
    });
    expect((await store.load('board')).updates).toHaveLength(0);

    const late = server.connect('board');
    await waitForSynced(late);
    expect(getShape(late.doc, note.id)).toMatchObject({ x: 25 });
  });

  it('persists every room on graceful shutdown', async () => {
    const store = new MemoryStore();
    server = await startTestServer({}, store);
    const alice = server.connect('board');
    await waitForSynced(alice);
    const note = sticky('alice');
    addShape(alice.doc, note);
    await waitFor(() => server.app.rooms.getLoadedRoom('board')!.hasUncompactedUpdates);

    await server.app.close();
    const restored = new Y.Doc();
    const { snapshot, updates } = await store.load('board');
    if (snapshot) Y.applyUpdate(restored, snapshot);
    for (const update of updates) Y.applyUpdate(restored, update);
    expect(getShape(restored, note.id)).not.toBeNull();
  });
});

describe('HTTP surface', () => {
  it('serves health and issues tokens that open rooms', async () => {
    server = await startTestServer();
    const health = HealthResponseSchema.parse(
      await (await fetch(`${server.httpUrl}/healthz`)).json(),
    );
    expect(health).toMatchObject({ status: 'ok', persistence: 'memory' });

    const response = await fetch(`${server.httpUrl}/api/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'board', name: 'Ada' }),
    });
    expect(response.status).toBe(200);
    const { token } = TokenResponseSchema.parse(await response.json());
    await expect(server.app.tokens.verify(token)).resolves.toMatchObject({
      room: 'board',
      role: 'editor',
    });
  });

  it('validates token requests', async () => {
    server = await startTestServer();
    const response = await fetch(`${server.httpUrl}/api/token`, {
      method: 'POST',
      body: JSON.stringify({ roomId: '../../etc', name: 'x' }),
    });
    expect(response.status).toBe(400);
  });

  it.each([
    ['missing token', async () => '/rooms/board', 401],
    ['garbage token', async () => '/rooms/board?token=nope', 401],
    [
      'token for another room',
      async () => `/rooms/board?token=${await server.token('other')}`,
      403,
    ],
    ['invalid room id', async () => `/rooms/${encodeURIComponent('a b')}?token=x`, 400],
  ])('rejects upgrades with %s', async (_label, path, status) => {
    server = await startTestServer();
    expect(await upgradeStatus(`${server.httpUrl}${await path()}`)).toBe(status);
  });
});

/** Attempts a WebSocket handshake and reports the HTTP status the server answered with. */
function upgradeStatus(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}
