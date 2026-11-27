import type { PresenceUser } from '@canvas-collab/shared';
import type { CollabProvider } from '@canvas-collab/shared/client';
import { useEffect, useState } from 'react';
import {
  type BoardSession,
  connectBoardSession,
  createBoardSession,
  destroyBoardSession,
} from '../lib/session';

export interface CollabSession {
  session: BoardSession;
  provider: CollabProvider;
}

/**
 * Creates the Y.Doc, awareness, undo manager and network provider for a room and tears
 * them down when the room changes or the component unmounts. Created inside an effect so
 * StrictMode's mount/unmount/mount cycle never leaks a socket.
 */
export function useCollabSession(roomId: string, user: PresenceUser): CollabSession | null {
  const [state, setState] = useState<CollabSession | null>(null);

  useEffect(() => {
    const session = createBoardSession(user);
    const provider = connectBoardSession(session, roomId);
    setState({ session, provider });

    // Reconnect promptly when the network returns instead of waiting out the backoff.
    const handleOnline = () => {
      provider.disconnect();
      provider.connect();
    };
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
      provider.destroy();
      destroyBoardSession(session);
      setState(null);
    };
  }, [roomId, user]);

  return state;
}
