import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addShape,
  bringToFront,
  createId,
  createUndoManager,
  deleteShapes,
  duplicateShapes,
  getShape,
  getShapesMap,
  makeBoxShape,
  makeConnector,
  readShapes,
  updateShape,
  updateShapes,
} from '../src';

const LOCAL = Symbol('local');

function boardWith(...kinds: ('sticky' | 'rect' | 'ellipse')[]) {
  const doc = new Y.Doc();
  const ids = kinds.map((kind, i) => {
    const shape = makeBoxShape(kind, { x: i * 300, y: 0 }, { createdBy: 'u1', zIndex: i + 1 });
    addShape(doc, shape, LOCAL);
    return shape.id;
  });
  return { doc, ids };
}

/** Exchanges full state between docs, simulating two peers syncing. */
function syncDocs(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe('doc helpers', () => {
  it('creates ids that are unique and schema-safe', () => {
    const ids = new Set(Array.from({ length: 1_000 }, createId));
    expect(ids.size).toBe(1_000);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{16}$/);
  });

  it('adds and reads shapes in z-order', () => {
    const { doc, ids } = boardWith('rect', 'sticky');
    bringToFront(doc, [ids[0]!]);
    expect(readShapes(doc).map((s) => s.id)).toEqual([ids[1], ids[0]]);
  });

  it('rejects invalid shapes before touching the document', () => {
    const doc = new Y.Doc();
    const bad = {
      ...makeBoxShape('rect', { x: 0, y: 0 }, { createdBy: 'u', zIndex: 1 }),
      width: -5,
    };
    expect(() => addShape(doc, bad)).toThrow();
    expect(getShapesMap(doc).size).toBe(0);
  });

  it('skips shapes a peer wrote in an invalid form', () => {
    const { doc } = boardWith('sticky');
    const rogue = new Y.Map<unknown>();
    rogue.set('kind', 'sticky');
    rogue.set('x', 'not-a-number');
    getShapesMap(doc).set('rogue', rogue);
    expect(readShapes(doc)).toHaveLength(1);
  });

  it('only writes fields that changed', () => {
    const { doc, ids } = boardWith('sticky');
    const id = ids[0]!;
    let transactions = 0;
    doc.on('afterTransaction', () => transactions++);
    const before = getShape(doc, id)!;
    updateShape(doc, id, { x: before.kind === 'connector' ? 0 : before.x });
    expect(transactions).toBe(0);
    updateShape(doc, id, { text: 'hi' });
    expect(transactions).toBe(1);
    expect(getShape(doc, id)).toMatchObject({ text: 'hi' });
  });

  it('refuses patches that would invalidate a shape', () => {
    const { doc, ids } = boardWith('rect');
    expect(() => updateShape(doc, ids[0]!, { width: 0 })).toThrow();
  });

  it('cascades deletes to attached connectors', () => {
    const { doc, ids } = boardWith('rect', 'rect', 'rect');
    const [a, b, c] = ids as [string, string, string];
    addShape(doc, makeConnector(a, b, { createdBy: 'u1', zIndex: 10 }));
    addShape(doc, makeConnector(b, c, { createdBy: 'u1', zIndex: 11 }));
    deleteShapes(doc, [a]);
    const remaining = readShapes(doc);
    expect(remaining.map((s) => s.kind).sort()).toEqual(['connector', 'rect', 'rect']);
  });

  it('duplicates shapes and rewires internal connectors', () => {
    const { doc, ids } = boardWith('rect', 'rect');
    const [a, b] = ids as [string, string];
    const connector = makeConnector(a, b, { createdBy: 'u1', zIndex: 10 });
    addShape(doc, connector);
    const copies = duplicateShapes(doc, [a, b, connector.id], { x: 20, y: 20 }, 'u2');
    expect(copies).toHaveLength(3);
    const copiedConnector = copies
      .map((id) => getShape(doc, id))
      .find((shape) => shape?.kind === 'connector');
    expect(copiedConnector).toMatchObject({ kind: 'connector', createdBy: 'u2' });
    if (copiedConnector?.kind !== 'connector') throw new Error('expected connector');
    expect(copies).toContain(copiedConnector.fromId);
    expect(copies).toContain(copiedConnector.toId);
  });

  it('merges concurrent edits to different fields of the same shape', () => {
    const { doc: alice, ids } = boardWith('sticky');
    const id = ids[0]!;
    const bob = new Y.Doc();
    syncDocs(alice, bob);

    updateShape(alice, id, { x: 500, y: 400 });
    updateShape(bob, id, { text: 'from bob' });
    syncDocs(alice, bob);

    expect(getShape(alice, id)).toMatchObject({ x: 500, y: 400, text: 'from bob' });
    expect(readShapes(alice)).toEqual(readShapes(bob));
  });

  it('converges to the same winner on concurrent writes to the same field', () => {
    const { doc: alice, ids } = boardWith('rect');
    const id = ids[0]!;
    const bob = new Y.Doc();
    syncDocs(alice, bob);
    updateShapes(alice, { [id]: { x: 1 } });
    updateShapes(bob, { [id]: { x: 2 } });
    syncDocs(alice, bob);
    expect(readShapes(alice)).toEqual(readShapes(bob));
  });
});

describe('createUndoManager', () => {
  it('undoes only changes made with the local origin', () => {
    const doc = new Y.Doc();
    const undo = createUndoManager(doc, LOCAL);
    const mine = makeBoxShape('sticky', { x: 0, y: 0 }, { createdBy: 'me', zIndex: 1 });
    addShape(doc, mine, LOCAL);
    undo.stopCapturing();
    const remote = makeBoxShape('rect', { x: 0, y: 0 }, { createdBy: 'them', zIndex: 2 });
    addShape(doc, remote, 'remote-provider');

    undo.undo();
    expect(readShapes(doc).map((s) => s.id)).toEqual([remote.id]);
    undo.redo();
    expect(readShapes(doc)).toHaveLength(2);
  });

  it('restores connectors removed by a cascading delete in one step', () => {
    const { doc, ids } = boardWith('rect', 'rect');
    const undo = createUndoManager(doc, LOCAL);
    addShape(doc, makeConnector(ids[0]!, ids[1]!, { createdBy: 'u1', zIndex: 5 }), LOCAL);
    undo.stopCapturing();
    deleteShapes(doc, [ids[0]!], LOCAL);
    expect(readShapes(doc)).toHaveLength(1);
    undo.undo();
    expect(readShapes(doc)).toHaveLength(3);
  });
});
