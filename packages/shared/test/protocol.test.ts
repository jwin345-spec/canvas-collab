import { Awareness } from 'y-protocols/awareness';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MessageType,
  SyncMessageType,
  addShape,
  backoffDelay,
  decodeFrame,
  encodeAwarenessUpdate,
  encodeSyncStep1,
  encodeUpdate,
  handleAwarenessPayload,
  handleSyncPayload,
  makeBoxShape,
  readShapes,
} from './exports';

function populatedDoc() {
  const doc = new Y.Doc();
  addShape(doc, makeBoxShape('sticky', { x: 0, y: 0 }, { createdBy: 'u', zIndex: 1 }));
  return doc;
}

describe('sync protocol', () => {
  it('answers step1 with a step2 that brings the peer up to date', () => {
    const server = populatedDoc();
    const client = new Y.Doc();

    const step1 = decodeFrame(encodeSyncStep1(client));
    expect(step1.type).toBe(MessageType.Sync);
    const { reply, syncType } = handleSyncPayload(step1.decoder, server, 'client');
    expect(syncType).toBe(SyncMessageType.Step1);
    expect(reply).not.toBeNull();

    const step2 = decodeFrame(reply!);
    const result = handleSyncPayload(step2.decoder, client, 'server');
    expect(result.syncType).toBe(SyncMessageType.Step2);
    expect(result.reply).toBeNull();
    expect(readShapes(client)).toEqual(readShapes(server));
  });

  it('applies incremental updates with the given origin', () => {
    const source = populatedDoc();
    const target = new Y.Doc();
    const origins: unknown[] = [];
    target.on('update', (_update: Uint8Array, origin: unknown) => origins.push(origin));

    const { decoder } = decodeFrame(encodeUpdate(Y.encodeStateAsUpdate(source)));
    handleSyncPayload(decoder, target, 'peer-a');
    expect(origins).toEqual(['peer-a']);
    expect(readShapes(target)).toHaveLength(1);
  });

  it('drops writes from read-only peers but still serves their step1', () => {
    const server = new Y.Doc();
    const writer = populatedDoc();
    const update = decodeFrame(encodeUpdate(Y.encodeStateAsUpdate(writer)));
    expect(handleSyncPayload(update.decoder, server, 'v', { readOnly: true }).rejected).toBe(true);
    expect(readShapes(server)).toHaveLength(0);

    const step1 = decodeFrame(encodeSyncStep1(new Y.Doc()));
    const result = handleSyncPayload(step1.decoder, server, 'v', { readOnly: true });
    expect(result.rejected).toBe(false);
    expect(result.reply).not.toBeNull();
  });

  it('round-trips awareness state', () => {
    const a = new Awareness(new Y.Doc());
    const b = new Awareness(new Y.Doc());
    a.setLocalState({
      user: { id: 'u', name: 'Ada', color: '#3b82f6' },
      cursor: null,
      selection: [],
    });

    const frame = decodeFrame(encodeAwarenessUpdate(a, [a.clientID]));
    expect(frame.type).toBe(MessageType.Awareness);
    handleAwarenessPayload(frame.decoder, b, 'remote');
    expect(b.getStates().get(a.clientID)).toMatchObject({ user: { name: 'Ada' } });
    a.destroy();
    b.destroy();
  });

  it('throws on truncated frames instead of misreading them', () => {
    expect(() => decodeFrame(new Uint8Array())).toThrow();
  });
});

describe('backoffDelay', () => {
  const options = { initialDelayMs: 100, maxDelayMs: 1_000 };

  it('grows exponentially up to the cap', () => {
    const max = () => 1;
    expect(backoffDelay(0, options, max)).toBe(100);
    expect(backoffDelay(3, options, max)).toBe(800);
    expect(backoffDelay(10, options, max)).toBe(1_000);
  });

  it('applies full jitter', () => {
    expect(backoffDelay(3, options, () => 0)).toBe(0);
    expect(backoffDelay(3, options, () => 0.5)).toBe(400);
  });
});
