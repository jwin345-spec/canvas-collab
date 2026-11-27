import * as Y from 'yjs';
import {
  type BoxPatch,
  type BoxShape,
  type Connector,
  type Point,
  SHAPE_FILLS,
  STICKY_COLORS,
  STROKE_COLOR,
  type Shape,
  type ShapeId,
  ShapeSchema,
  isBoxShape,
} from './schema';

/**
 * Board document layout:
 *
 *   doc.getMap('shapes'): Y.Map<ShapeId, Y.Map<field, value>>
 *
 * Each shape is its own nested Y.Map rather than a plain JSON object so that concurrent
 * edits to *different fields* of the same shape merge (Alice drags a note while Bob edits
 * its text and both changes survive). Concurrent edits to the *same* field resolve
 * last-writer-wins, which is the right behaviour for geometry.
 *
 * All mutations go through these helpers so they are transactional, validated, and tagged
 * with an origin the UndoManager can filter on.
 */

export const SHAPES_KEY = 'shapes';

export type ShapeYMap = Y.Map<unknown>;
export type ShapesYMap = Y.Map<ShapeYMap>;

export function getShapesMap(doc: Y.Doc): ShapesYMap {
  return doc.getMap<ShapeYMap>(SHAPES_KEY);
}

/** Validates a nested shape map; returns null for anything a peer wrote that we cannot render. */
export function readShape(ymap: ShapeYMap): Shape | null {
  const parsed = ShapeSchema.safeParse(ymap.toJSON());
  return parsed.success ? parsed.data : null;
}

export function compareShapes(a: Shape, b: Shape): number {
  return a.zIndex - b.zIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** All valid shapes in paint order (back to front). */
export function readShapes(doc: Y.Doc): Shape[] {
  const shapes: Shape[] = [];
  getShapesMap(doc).forEach((ymap) => {
    const shape = readShape(ymap);
    if (shape) shapes.push(shape);
  });
  return shapes.sort(compareShapes);
}

export function getShape(doc: Y.Doc, id: ShapeId): Shape | null {
  const ymap = getShapesMap(doc).get(id);
  return ymap ? readShape(ymap) : null;
}

export function nextZIndex(doc: Y.Doc): number {
  let max = 0;
  getShapesMap(doc).forEach((ymap) => {
    const z = ymap.get('zIndex');
    if (typeof z === 'number' && Number.isFinite(z) && z > max) max = z;
  });
  return max + 1;
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** 16 random base36 characters (~82 bits): collision-free for any realistic board. */
export function createId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let id = '';
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

function toYMap(shape: Shape): ShapeYMap {
  const ymap = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(shape)) ymap.set(key, value);
  return ymap;
}

export function addShapes(doc: Y.Doc, shapes: readonly Shape[], origin?: unknown): void {
  const validated = shapes.map((shape) => ShapeSchema.parse(shape));
  doc.transact(() => {
    const map = getShapesMap(doc);
    for (const shape of validated) map.set(shape.id, toYMap(shape));
  }, origin);
}

export function addShape(doc: Y.Doc, shape: Shape, origin?: unknown): void {
  addShapes(doc, [shape], origin);
}

/**
 * Applies field-level patches to box shapes in one transaction. Only fields whose value
 * actually changes are written, so a no-op drag does not generate CRDT traffic. Patches
 * that would make a shape invalid throw before anything is written.
 */
export function updateShapes(
  doc: Y.Doc,
  patches: ReadonlyMap<ShapeId, BoxPatch> | Record<ShapeId, BoxPatch>,
  origin?: unknown,
): void {
  const entries = patches instanceof Map ? [...patches] : Object.entries(patches);
  const map = getShapesMap(doc);
  const writes: [ShapeYMap, [string, unknown][]][] = [];

  for (const [id, patch] of entries) {
    const ymap = map.get(id);
    const current = ymap ? readShape(ymap) : null;
    if (!ymap || !current || !isBoxShape(current)) continue;
    const next = ShapeSchema.parse({ ...current, ...patch });
    const changed = Object.entries(patch).filter(
      ([key]) => (next as Record<string, unknown>)[key] !== ymap.get(key),
    );
    if (changed.length > 0) writes.push([ymap, changed]);
  }

  if (writes.length === 0) return;
  doc.transact(() => {
    for (const [ymap, changed] of writes) {
      for (const [key, value] of changed) ymap.set(key, value);
    }
  }, origin);
}

export function updateShape(doc: Y.Doc, id: ShapeId, patch: BoxPatch, origin?: unknown): void {
  updateShapes(doc, { [id]: patch }, origin);
}

/** Deletes shapes plus any connector left dangling by the deletion, as one undoable step. */
export function deleteShapes(doc: Y.Doc, ids: Iterable<ShapeId>, origin?: unknown): void {
  const doomed = new Set(ids);
  if (doomed.size === 0) return;
  const map = getShapesMap(doc);
  map.forEach((ymap, id) => {
    const from = ymap.get('fromId');
    const to = ymap.get('toId');
    if (
      (typeof from === 'string' && doomed.has(from)) ||
      (typeof to === 'string' && doomed.has(to))
    ) {
      doomed.add(id);
    }
  });
  doc.transact(() => {
    for (const id of doomed) map.delete(id);
  }, origin);
}

/** Raises the given shapes above everything else, preserving their relative order. */
export function bringToFront(doc: Y.Doc, ids: readonly ShapeId[], origin?: unknown): void {
  const shapes = ids
    .map((id) => getShape(doc, id))
    .filter((shape): shape is Shape => shape !== null)
    .sort(compareShapes);
  if (shapes.length === 0) return;
  let z = nextZIndex(doc);
  const map = getShapesMap(doc);
  doc.transact(() => {
    for (const shape of shapes) map.get(shape.id)?.set('zIndex', z++);
  }, origin);
}

/**
 * Copies shapes with an offset. Connectors are copied only when both ends are part of the
 * copy, and are rewired to the new shapes. Returns the ids of the copies.
 */
export function duplicateShapes(
  doc: Y.Doc,
  ids: readonly ShapeId[],
  offset: Point,
  createdBy: string,
  origin?: unknown,
): ShapeId[] {
  const originals = ids
    .map((id) => getShape(doc, id))
    .filter((shape): shape is Shape => shape !== null)
    .sort(compareShapes);
  const idMap = new Map(originals.map((shape) => [shape.id, createId()]));
  let z = nextZIndex(doc);
  const copies: Shape[] = [];

  for (const shape of originals) {
    const id = idMap.get(shape.id);
    if (!id) continue;
    if (isBoxShape(shape)) {
      copies.push({
        ...shape,
        id,
        x: shape.x + offset.x,
        y: shape.y + offset.y,
        zIndex: z++,
        createdBy,
      });
    } else {
      const fromId = idMap.get(shape.fromId);
      const toId = idMap.get(shape.toId);
      if (fromId && toId) copies.push({ ...shape, id, fromId, toId, zIndex: z++, createdBy });
    }
  }
  addShapes(doc, copies, origin);
  return copies.map((shape) => shape.id);
}

export type BoxKind = BoxShape['kind'];

export const DEFAULT_SIZES: Record<BoxKind, { width: number; height: number }> = {
  sticky: { width: 180, height: 160 },
  rect: { width: 200, height: 120 },
  ellipse: { width: 160, height: 120 },
};

/** Builds a new box shape centred on `center` with sensible defaults. */
export function makeBoxShape(
  kind: BoxKind,
  center: Point,
  options: { createdBy: string; zIndex: number; id?: string; variant?: number },
): BoxShape {
  const { width, height } = DEFAULT_SIZES[kind];
  const variant = options.variant ?? 0;
  const base = {
    id: options.id ?? createId(),
    x: Math.round(center.x - width / 2),
    y: Math.round(center.y - height / 2),
    width,
    height,
    zIndex: options.zIndex,
    createdBy: options.createdBy,
  };
  switch (kind) {
    case 'sticky':
      return {
        ...base,
        kind,
        text: '',
        color: STICKY_COLORS[variant % STICKY_COLORS.length] ?? STICKY_COLORS[0],
      };
    case 'rect':
    case 'ellipse':
      return {
        ...base,
        kind,
        fill: SHAPE_FILLS[variant % SHAPE_FILLS.length] ?? SHAPE_FILLS[0],
        stroke: STROKE_COLOR,
      };
  }
}

export function makeConnector(
  fromId: ShapeId,
  toId: ShapeId,
  options: { createdBy: string; zIndex: number; id?: string },
): Connector {
  return {
    id: options.id ?? createId(),
    kind: 'connector',
    fromId,
    toId,
    stroke: STROKE_COLOR,
    zIndex: options.zIndex,
    createdBy: options.createdBy,
  };
}

/**
 * Undo/redo scoped to one user: only transactions carrying `localOrigin` are captured, so
 * undoing never reverts a collaborator's work. Remote updates arrive with the provider as
 * their origin and are therefore ignored.
 */
export function createUndoManager(doc: Y.Doc, localOrigin: unknown): Y.UndoManager {
  return new Y.UndoManager(getShapesMap(doc), {
    trackedOrigins: new Set([localOrigin]),
    captureTimeout: 400,
  });
}
