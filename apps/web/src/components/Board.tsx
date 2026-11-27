import {
  type ShapeId,
  bringToFront,
  deleteShapes,
  duplicateShapes,
  isBoxShape,
  updateShapes,
  type BoxPatch,
} from '@canvas-collab/shared';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useAwarenessPeers } from '../hooks/useAwarenessPeers';
import { type ShortcutMap, useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useUndoState } from '../hooks/useUndoState';
import { useShapes } from '../hooks/useYMap';
import {
  IDENTITY_VIEWPORT,
  type Viewport,
  ZOOM_STEP,
  zoomAroundWindowCenter,
} from '../lib/geometry';
import type { BoardSession } from '../lib/session';
import { TOOLS, type Tool } from '../lib/tools';
import styles from './Board.module.css';
import { Canvas } from './Canvas';
import { PresenceBar } from './PresenceBar';
import { Toolbar } from './Toolbar';
import { ZoomControls } from './ZoomControls';

export interface BoardProps {
  session: BoardSession;
  roomId: string;
  /** Slot for the connection indicator; absent when rendering without a network provider. */
  connection?: ReactNode;
}

const EMPTY_SELECTION: ReadonlySet<ShapeId> = new Set();
const NUDGE = 1;
const NUDGE_LARGE = 10;
const DUPLICATE_OFFSET = { x: 24, y: 24 };

/**
 * Board screen. Owns purely local UI state (tool, selection, viewport, editor) and turns
 * user intent into document operations; the document itself is the single source of truth
 * for shapes.
 */
export function Board({ session, roomId, connection }: BoardProps) {
  const { doc, awareness, undoManager, localOrigin, user } = session;
  const shapes = useShapes(doc);
  const peers = useAwarenessPeers(awareness);
  const { canUndo, canRedo } = useUndoState(undoManager);
  const [tool, setTool] = useState<Tool>('select');
  const [rawSelection, setSelection] = useState<ReadonlySet<ShapeId>>(EMPTY_SELECTION);
  const [viewport, setViewport] = useState<Viewport>(IDENTITY_VIEWPORT);
  const [editingId, setEditingId] = useState<ShapeId | null>(null);
  const [copied, setCopied] = useState(false);

  // Shapes can disappear underneath us (remote delete, undo); never act on stale ids.
  const selection = useMemo(() => {
    const live = [...rawSelection].filter((id) => shapes.byId.has(id));
    return live.length === rawSelection.size ? rawSelection : new Set(live);
  }, [rawSelection, shapes.byId]);
  const activeEditingId = editingId && shapes.byId.has(editingId) ? editingId : null;

  useEffect(() => {
    awareness.setLocalStateField('selection', [...selection]);
  }, [awareness, selection]);

  const deleteSelection = useCallback(() => {
    if (selection.size === 0) return;
    deleteShapes(doc, selection, localOrigin);
    undoManager.stopCapturing();
    setSelection(EMPTY_SELECTION);
  }, [doc, selection, localOrigin, undoManager]);

  const undo = useCallback(() => {
    setEditingId(null);
    undoManager.undo();
  }, [undoManager]);

  const redo = useCallback(() => {
    setEditingId(null);
    undoManager.redo();
  }, [undoManager]);

  const nudge = (dx: number, dy: number) => {
    const patches = new Map<ShapeId, BoxPatch>();
    for (const id of selection) {
      const shape = shapes.byId.get(id);
      if (shape && isBoxShape(shape)) patches.set(id, { x: shape.x + dx, y: shape.y + dy });
    }
    updateShapes(doc, patches, localOrigin);
  };

  const shortcuts: ShortcutMap = {
    'mod+z': undo,
    'mod+shift+z': redo,
    'mod+y': redo,
    delete: deleteSelection,
    backspace: deleteSelection,
    escape: () => {
      setSelection(EMPTY_SELECTION);
      setTool('select');
    },
    'mod+a': () => setSelection(new Set(shapes.list.map((shape) => shape.id))),
    'mod+d': () => {
      const copies = duplicateShapes(doc, [...selection], DUPLICATE_OFFSET, user.id, localOrigin);
      undoManager.stopCapturing();
      setSelection(new Set(copies));
    },
    ']': () => bringToFront(doc, [...selection], localOrigin),
    arrowleft: () => nudge(-NUDGE, 0),
    arrowright: () => nudge(NUDGE, 0),
    arrowup: () => nudge(0, -NUDGE),
    arrowdown: () => nudge(0, NUDGE),
    'shift+arrowleft': () => nudge(-NUDGE_LARGE, 0),
    'shift+arrowright': () => nudge(NUDGE_LARGE, 0),
    'shift+arrowup': () => nudge(0, -NUDGE_LARGE),
    'shift+arrowdown': () => nudge(0, NUDGE_LARGE),
    '=': () => setViewport((vp) => zoomAroundWindowCenter(vp, ZOOM_STEP)),
    '+': () => setViewport((vp) => zoomAroundWindowCenter(vp, ZOOM_STEP)),
    'shift++': () => setViewport((vp) => zoomAroundWindowCenter(vp, ZOOM_STEP)),
    '-': () => setViewport((vp) => zoomAroundWindowCenter(vp, 1 / ZOOM_STEP)),
    '0': () => setViewport(IDENTITY_VIEWPORT),
  };
  for (const { id, shortcut } of TOOLS) shortcuts[shortcut.toLowerCase()] = () => setTool(id);
  useKeyboardShortcuts(shortcuts, activeEditingId === null);

  const copyInviteLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied; the URL bar still holds the link.
    }
  };

  return (
    <div className={styles.board}>
      <Canvas
        session={session}
        shapes={shapes}
        peers={peers}
        tool={tool}
        onToolChange={setTool}
        selection={selection}
        onSelectionChange={setSelection}
        viewport={viewport}
        onViewportChange={setViewport}
        editingId={activeEditingId}
        onEditingChange={setEditingId}
      />

      <header className={styles.header}>
        <div className={styles.brand}>
          <h1 className={styles.title}>canvas-collab</h1>
          <span className={styles.room} title="Room id">
            {roomId}
          </span>
        </div>
        <div className={styles.actions}>
          <PresenceBar self={user} peers={peers} />
          {connection}
          <button type="button" className={styles.share} onClick={() => void copyInviteLink()}>
            {copied ? 'Link copied' : 'Copy invite link'}
          </button>
        </div>
      </header>

      <Toolbar
        tool={tool}
        onToolChange={setTool}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        hasSelection={selection.size > 0}
        onDelete={deleteSelection}
      />
      <ZoomControls viewport={viewport} onViewportChange={setViewport} />
      <p className={styles.hint} aria-hidden="true">
        {shapes.list.length === 0
          ? 'Pick a tool on the left, or double-click anywhere to add a sticky note.'
          : `${shapes.list.length} ${shapes.list.length === 1 ? 'item' : 'items'}`}
      </p>
    </div>
  );
}
