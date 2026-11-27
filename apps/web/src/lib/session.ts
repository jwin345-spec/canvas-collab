import { createUndoManager, type PresenceState, type PresenceUser } from '@canvas-collab/shared';
import { CollabProvider } from '@canvas-collab/shared/client';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createTokenSource, serverWsUrl } from './api';

/**
 * Everything the board UI needs to read and write shared state. Deliberately free of any
 * networking so components can be rendered against a bare Y.Doc in tests.
 */
export interface BoardSession {
  doc: Y.Doc;
  awareness: Awareness;
  undoManager: Y.UndoManager;
  /** Transaction origin for local edits; the only origin the UndoManager tracks. */
  localOrigin: object;
  user: PresenceUser;
}

export function createBoardSession(user: PresenceUser, doc = new Y.Doc()): BoardSession {
  const awareness = new Awareness(doc);
  const localOrigin = { source: 'local-user', userId: user.id };
  const initial: PresenceState = { user, cursor: null, selection: [] };
  awareness.setLocalState(initial);
  return { doc, awareness, undoManager: createUndoManager(doc, localOrigin), localOrigin, user };
}

export function destroyBoardSession(session: BoardSession): void {
  session.undoManager.destroy();
  session.awareness.destroy();
  session.doc.destroy();
}

export function connectBoardSession(session: BoardSession, roomId: string): CollabProvider {
  return new CollabProvider({
    serverUrl: serverWsUrl(),
    roomId,
    doc: session.doc,
    awareness: session.awareness,
    getToken: createTokenSource(roomId, session.user),
  });
}
