import { compareShapes, getShapesMap, readShape, type Shape } from '@canvas-collab/shared';
import { useMemo, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';

interface ExternalStore<T> {
  subscribe(onChange: () => void): () => void;
  getSnapshot(): T;
}

/**
 * Adapts a Yjs type to `useSyncExternalStore`. The snapshot is recomputed lazily, at most
 * once per batch of changes, and is referentially stable between changes, which is what
 * React requires to avoid render loops and tearing.
 */
function createYStore<T>(type: Y.AbstractType<unknown>, compute: () => T): ExternalStore<T> {
  let snapshot = compute();
  let dirty = false;
  return {
    subscribe(onChange) {
      const handler = () => {
        dirty = true;
        onChange();
      };
      type.observeDeep(handler);
      // Changes between store creation and subscription would otherwise be missed.
      dirty = true;
      return () => type.unobserveDeep(handler);
    },
    getSnapshot() {
      if (dirty) {
        snapshot = compute();
        dirty = false;
      }
      return snapshot;
    },
  };
}

/**
 * `useYMap`: subscribe a component to a Y.Map (deeply) and derive a value from it.
 * `select` should be stable (module-level or memoised) since the store is rebuilt when it
 * changes.
 */
export function useYMap<V, T>(ymap: Y.Map<V>, select: (map: Y.Map<V>) => T): T {
  const store = useMemo(
    () => createYStore(ymap as Y.AbstractType<unknown>, () => select(ymap)),
    [ymap, select],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

function shallowEqual(a: object, b: object): boolean {
  const aEntries = Object.entries(a);
  if (aEntries.length !== Object.keys(b).length) return false;
  return aEntries.every(([key, value]) => Object.is(value, (b as Record<string, unknown>)[key]));
}

export interface ShapesSnapshot {
  /** Valid shapes in paint order (back to front). */
  list: readonly Shape[];
  byId: ReadonlyMap<string, Shape>;
}

/**
 * Validated board shapes. Unchanged shapes keep their object identity across updates, so
 * memoised shape components re-render only when their own shape changed.
 */
export function useShapes(doc: Y.Doc): ShapesSnapshot {
  const ymap = useMemo(() => getShapesMap(doc), [doc]);
  const select = useMemo(() => {
    let previous = new Map<string, Shape>();
    return (map: Y.Map<Y.Map<unknown>>): ShapesSnapshot => {
      const byId = new Map<string, Shape>();
      map.forEach((shapeMap, id) => {
        const shape = readShape(shapeMap);
        if (!shape) return;
        const prior = previous.get(id);
        byId.set(id, prior && shallowEqual(prior, shape) ? prior : shape);
      });
      previous = byId;
      return { list: [...byId.values()].sort(compareShapes), byId };
    };
  }, []);
  return useYMap(ymap, select);
}
