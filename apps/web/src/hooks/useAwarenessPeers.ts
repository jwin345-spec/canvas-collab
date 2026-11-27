import { type PresenceState, PresenceStateSchema } from '@canvas-collab/shared';
import { useMemo, useSyncExternalStore } from 'react';
import type { Awareness } from 'y-protocols/awareness';

export interface Peer {
  clientId: number;
  state: PresenceState;
}

/**
 * Remote participants with a valid presence state, ordered by client id for a stable UI.
 * Several tabs of the same user appear as separate peers on purpose: each has its own
 * cursor.
 */
export function useAwarenessPeers(awareness: Awareness): readonly Peer[] {
  const store = useMemo(() => {
    let snapshot: readonly Peer[] = [];
    const compute = () => {
      const peers: Peer[] = [];
      awareness.getStates().forEach((raw, clientId) => {
        if (clientId === awareness.clientID) return;
        const parsed = PresenceStateSchema.safeParse(raw);
        if (parsed.success) peers.push({ clientId, state: parsed.data });
      });
      snapshot = peers.sort((a, b) => a.clientId - b.clientId);
    };
    compute();
    return {
      subscribe(onChange: () => void) {
        // 'change' fires only when a state's content changed, unlike 'update' which also
        // fires on the 15s keep-alive renewals.
        const handler = () => {
          compute();
          onChange();
        };
        awareness.on('change', handler);
        return () => awareness.off('change', handler);
      },
      getSnapshot: () => snapshot,
    };
  }, [awareness]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
