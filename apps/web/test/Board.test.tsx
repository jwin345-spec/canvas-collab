import {
  addShape,
  getShape,
  getShapesMap,
  makeBoxShape,
  readShapes,
  type PresenceState,
} from '@canvas-collab/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Board } from '../src/components/Board';
import { type BoardSession, createBoardSession, destroyBoardSession } from '../src/lib/session';

const user = { id: 'local-user', name: 'Calm Heron', color: '#ef4444' };
let session: BoardSession;

beforeEach(() => {
  session = createBoardSession(user);
});
afterEach(() => {
  destroyBoardSession(session);
});

function renderBoard() {
  render(<Board session={session} roomId="test-room" />);
  return screen.getByRole('application', { name: 'Whiteboard canvas' });
}

/** Applies a change made on another replica, the way the provider would. */
function remoteChange(change: (doc: Y.Doc) => void) {
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(session.doc));
  const before = Y.encodeStateVector(remote);
  change(remote);
  act(() => Y.applyUpdate(session.doc, Y.encodeStateAsUpdate(remote, before), 'remote'));
}

function shapeElement(id: string): Element {
  const element = document.querySelector(`[data-shape-id="${id}"]`);
  if (!element) throw new Error(`shape ${id} not rendered`);
  return element;
}

function drag(target: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.pointerDown(target, { clientX: from.x, clientY: from.y, button: 0, pointerId: 1 });
  fireEvent.pointerMove(target, { clientX: to.x, clientY: to.y, pointerId: 1 });
  fireEvent.pointerUp(target, { clientX: to.x, clientY: to.y, pointerId: 1 });
}

describe('Board', () => {
  it('creates a sticky note with the sticky tool and edits it inline', async () => {
    const canvas = renderBoard();
    await userEvent.click(screen.getByRole('button', { name: 'Sticky note' }));
    fireEvent.pointerDown(canvas, { clientX: 300, clientY: 200, button: 0, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 300, clientY: 200, pointerId: 1 });

    const [note] = readShapes(session.doc);
    expect(note).toMatchObject({ kind: 'sticky', createdBy: user.id });
    expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');

    const editor = screen.getByRole('textbox', { name: 'Sticky note text' });
    expect(editor).toHaveFocus();
    await userEvent.type(editor, 'Ship it');
    expect(getShape(session.doc, note!.id)).toMatchObject({ text: 'Ship it' });
  });

  it('renders shapes created by collaborators', () => {
    renderBoard();
    const shape = makeBoxShape('rect', { x: 100, y: 100 }, { createdBy: 'peer', zIndex: 1 });
    remoteChange((doc) => addShape(doc, shape));
    expect(shapeElement(shape.id)).toHaveAttribute('aria-label', 'Rectangle');
  });

  it('moves the selection by dragging', () => {
    const shape = makeBoxShape('rect', { x: 100, y: 100 }, { createdBy: user.id, zIndex: 1 });
    addShape(session.doc, shape);
    renderBoard();

    drag(shapeElement(shape.id), { x: 100, y: 100 }, { x: 150, y: 130 });
    expect(getShape(session.doc, shape.id)).toMatchObject({ x: shape.x + 50, y: shape.y + 30 });
    expect(shapeElement(shape.id)).toHaveAttribute('aria-pressed', 'true');
  });

  it('selects shapes with a marquee', () => {
    const inside = makeBoxShape('ellipse', { x: 100, y: 100 }, { createdBy: 'u', zIndex: 1 });
    const outside = makeBoxShape('ellipse', { x: 900, y: 900 }, { createdBy: 'u', zIndex: 2 });
    addShape(session.doc, inside);
    addShape(session.doc, outside);
    const canvas = renderBoard();

    drag(canvas, { x: 0, y: 0 }, { x: 250, y: 250 });
    expect(shapeElement(inside.id)).toHaveAttribute('aria-pressed', 'true');
    expect(shapeElement(outside.id)).toHaveAttribute('aria-pressed', 'false');
  });

  it('deletes with the keyboard and undoes only local changes', async () => {
    const mine = makeBoxShape('rect', { x: 100, y: 100 }, { createdBy: user.id, zIndex: 1 });
    addShape(session.doc, mine);
    renderBoard();

    fireEvent.pointerDown(shapeElement(mine.id), { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerUp(shapeElement(mine.id), { clientX: 100, clientY: 100 });
    await userEvent.keyboard('{Delete}');
    expect(getShapesMap(session.doc).has(mine.id)).toBe(false);

    const theirs = makeBoxShape('sticky', { x: 500, y: 100 }, { createdBy: 'peer', zIndex: 2 });
    remoteChange((doc) => addShape(doc, theirs));

    await userEvent.keyboard('{Control>}z{/Control}');
    expect(getShapesMap(session.doc).has(mine.id)).toBe(true);
    expect(getShapesMap(session.doc).has(theirs.id)).toBe(true);
    expect(screen.getByRole('button', { name: 'Redo' })).toBeEnabled();
  });

  it('switches tools with single-key shortcuts', async () => {
    renderBoard();
    await userEvent.keyboard('r');
    expect(screen.getByRole('button', { name: 'Rectangle' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows collaborators’ cursors and avatars from awareness', () => {
    renderBoard();
    const remoteAwareness = new Awareness(new Y.Doc());
    const state: PresenceState = {
      user: { id: 'ada', name: 'Ada Lovelace', color: '#3b82f6' },
      cursor: { x: 40, y: 60 },
      selection: [],
    };
    remoteAwareness.setLocalState(state);
    act(() =>
      applyAwarenessUpdate(
        session.awareness,
        encodeAwarenessUpdate(remoteAwareness, [remoteAwareness.clientID]),
        'remote',
      ),
    );

    expect(screen.getByTestId('remote-cursor')).toHaveTextContent('Ada Lovelace');
    expect(screen.getByRole('list', { name: '2 people in this room' })).toBeInTheDocument();
    remoteAwareness.destroy();
  });

  it('publishes the local selection to awareness', () => {
    const shape = makeBoxShape('rect', { x: 100, y: 100 }, { createdBy: user.id, zIndex: 1 });
    addShape(session.doc, shape);
    renderBoard();
    fireEvent.pointerDown(shapeElement(shape.id), { clientX: 100, clientY: 100, button: 0 });
    expect(session.awareness.getLocalState()).toMatchObject({ selection: [shape.id] });
  });
});
