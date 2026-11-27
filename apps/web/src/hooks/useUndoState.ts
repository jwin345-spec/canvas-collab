import { useCallback, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
}

const EVENTS = ['stack-item-added', 'stack-item-popped', 'stack-cleared'] as const;

export function useUndoState(undoManager: Y.UndoManager): UndoState {
  const subscribe = useCallback(
    (onChange: () => void) => {
      for (const event of EVENTS) undoManager.on(event, onChange);
      return () => {
        for (const event of EVENTS) undoManager.off(event, onChange);
      };
    },
    [undoManager],
  );
  const canUndo = useSyncExternalStore(subscribe, () => undoManager.canUndo());
  const canRedo = useSyncExternalStore(subscribe, () => undoManager.canRedo());
  return { canUndo, canRedo };
}
