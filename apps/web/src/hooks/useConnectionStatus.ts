import type { CollabProvider, ConnectionStatus } from '@canvas-collab/shared/client';
import { useEffect, useState } from 'react';

export interface ConnectionState {
  status: ConnectionStatus;
  synced: boolean;
}

export function useConnectionStatus(provider: CollabProvider | null): ConnectionState {
  const [state, setState] = useState<ConnectionState>({ status: 'disconnected', synced: false });

  useEffect(() => {
    if (!provider) return;
    const update = () => setState({ status: provider.status, synced: provider.synced });
    update();
    provider.on('status', update);
    provider.on('synced', update);
    return () => {
      provider.off('status', update);
      provider.off('synced', update);
    };
  }, [provider]);

  return state;
}
