import { useState } from 'react';
import { Board } from './components/Board';
import { ConnectionBadge } from './components/ConnectionBadge';
import { useCollabSession } from './hooks/useCollabSession';
import { useConnectionStatus } from './hooks/useConnectionStatus';
import { loadIdentity, resolveRoomId } from './lib/identity';

export function App() {
  const [user] = useState(loadIdentity);
  const [roomId] = useState(resolveRoomId);
  const collab = useCollabSession(roomId, user);
  const connection = useConnectionStatus(collab?.provider ?? null);

  if (!collab) {
    return (
      <p role="status" className="loading">
        Opening board…
      </p>
    );
  }

  return (
    <Board
      session={collab.session}
      roomId={roomId}
      connection={<ConnectionBadge status={connection.status} synced={connection.synced} />}
    />
  );
}
