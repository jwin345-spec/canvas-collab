import {
  type BoxShape,
  type Connector,
  type Point,
  type ShapeId,
  addShape,
  isBoxShape,
  makeBoxShape,
  makeConnector,
  nextZIndex,
  updateShape,
  updateShapes,
} from '@canvas-collab/shared';
import {
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Peer } from '../hooks/useAwarenessPeers';
import type { ShapesSnapshot } from '../hooks/useYMap';
import {
  type Rect,
  type ResizeHandle,
  type Viewport,
  hitTest,
  intersects,
  rectFromPoints,
  resizeRect,
  screenToWorld,
  zoomAt,
} from '../lib/geometry';
import type { BoardSession } from '../lib/session';
import { type Tool, isCreationTool } from '../lib/tools';
import styles from './Canvas.module.css';
import {
  MarqueePreview,
  RemoteCursors,
  RemoteSelections,
  SelectionOverlay,
  StickyEditor,
} from './Overlays';
import { ConnectorView, ShapeView } from './ShapeView';

export interface CanvasProps {
  session: BoardSession;
  shapes: ShapesSnapshot;
  peers: readonly Peer[];
  tool: Tool;
  onToolChange: (tool: Tool) => void;
  selection: ReadonlySet<ShapeId>;
  onSelectionChange: (selection: ReadonlySet<ShapeId>) => void;
  viewport: Viewport;
  onViewportChange: Dispatch<SetStateAction<Viewport>>;
  editingId: ShapeId | null;
  onEditingChange: (id: ShapeId | null) => void;
}

/** In-flight pointer gesture. Kept in a ref: it changes on every pointermove. */
type Gesture =
  | { kind: 'pan'; origin: Point; start: Viewport }
  | { kind: 'move'; origin: Point; originals: ReadonlyMap<ShapeId, Point> }
  | { kind: 'resize'; origin: Point; id: ShapeId; handle: ResizeHandle; original: Rect }
  | { kind: 'marquee'; origin: Point; base: ReadonlySet<ShapeId> }
  | { kind: 'connect'; fromId: ShapeId };

type Preview = { kind: 'marquee'; rect: Rect } | { kind: 'connect'; from: Point; to: Point } | null;

/** Throttles cursor broadcasts to one awareness update per animation frame. */
function useCursorBroadcast(session: BoardSession): (point: Point | null) => void {
  const pending = useRef<{ point: Point | null } | null>(null);
  const frame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return (point) => {
    pending.current = { point };
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      if (pending.current) session.awareness.setLocalStateField('cursor', pending.current.point);
      pending.current = null;
    });
  };
}

function closestData(target: EventTarget, attribute: string): string | null {
  return target instanceof Element
    ? (target.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null)
    : null;
}

export function Canvas({
  session,
  shapes,
  peers,
  tool,
  onToolChange,
  selection,
  onSelectionChange,
  viewport,
  onViewportChange,
  editingId,
  onEditingChange,
}: CanvasProps) {
  const { doc, undoManager, localOrigin, user } = session;
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  // Opening the editor is deferred to pointerup: the browser moves focus to the canvas
  // after pointerdown, which would immediately blur (and close) a freshly opened editor.
  const pendingEdit = useRef<ShapeId | null>(null);
  const [preview, setPreview] = useState<Preview>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const broadcastCursor = useCursorBroadcast(session);
  const ids = useId();
  const gridId = `${ids}-grid`;
  const arrowId = `${ids}-arrow`;

  const { boxes, connectors } = useMemo(() => {
    const boxList: BoxShape[] = [];
    const connectorList: Connector[] = [];
    for (const shape of shapes.list) {
      if (isBoxShape(shape)) boxList.push(shape);
      else connectorList.push(shape);
    }
    return { boxes: boxList, connectors: connectorList };
  }, [shapes.list]);

  const selectedBoxes = useMemo(
    () => boxes.filter((shape) => selection.has(shape.id)),
    [boxes, selection],
  );

  // Space + drag pans, as in most design tools.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== ' ') return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT') return;
      setSpaceHeld(event.type === 'keydown');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  // Wheel must be a non-passive native listener to be able to prevent page zoom/scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = svg.getBoundingClientRect();
      const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      if (event.ctrlKey || event.metaKey) {
        onViewportChange((vp) => zoomAt(vp, anchor, vp.zoom * Math.exp(-event.deltaY * 0.002)));
      } else {
        onViewportChange((vp) => ({ ...vp, x: vp.x - event.deltaX, y: vp.y - event.deltaY }));
      }
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [onViewportChange]);

  function toScreen(event: { clientX: number; clientY: number }): Point {
    const bounds = svgRef.current?.getBoundingClientRect();
    return { x: event.clientX - (bounds?.left ?? 0), y: event.clientY - (bounds?.top ?? 0) };
  }

  function toWorld(event: { clientX: number; clientY: number }): Point {
    return screenToWorld(toScreen(event), viewport);
  }

  function select(next: Iterable<ShapeId>) {
    onSelectionChange(new Set(next));
  }

  function createBox(kind: BoxShape['kind'], at: Point): BoxShape {
    const shape = makeBoxShape(kind, at, {
      createdBy: user.id,
      zIndex: nextZIndex(doc),
      variant: boxes.length,
    });
    addShape(doc, shape, localOrigin);
    undoManager.stopCapturing();
    select([shape.id]);
    return shape;
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0 && event.button !== 1) return;
    const world = toWorld(event);
    const shapeId = closestData(event.target, 'data-shape-id');
    const handle = closestData(event.target, 'data-handle') as ResizeHandle | null;
    svgRef.current?.setPointerCapture?.(event.pointerId);

    if (event.button === 1 || spaceHeld) {
      gesture.current = { kind: 'pan', origin: toScreen(event), start: viewport };
      return;
    }
    if (editingId) onEditingChange(null);

    if (isCreationTool(tool)) {
      const shape = createBox(tool, world);
      onToolChange('select');
      if (shape.kind === 'sticky') pendingEdit.current = shape.id;
      return;
    }

    if (tool === 'connector') {
      const from = shapeId ? shapes.byId.get(shapeId) : undefined;
      if (from && isBoxShape(from)) {
        gesture.current = { kind: 'connect', fromId: from.id };
        const origin = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
        setPreview({ kind: 'connect', from: origin, to: world });
      }
      return;
    }

    const single = selectedBoxes.length === 1 ? selectedBoxes[0] : undefined;
    if (handle && single) {
      undoManager.stopCapturing();
      gesture.current = { kind: 'resize', origin: world, id: single.id, handle, original: single };
      return;
    }

    if (shapeId) {
      let next = selection;
      if (event.shiftKey) {
        const toggled = new Set(selection);
        if (toggled.has(shapeId)) toggled.delete(shapeId);
        else toggled.add(shapeId);
        onSelectionChange(toggled);
        if (!toggled.has(shapeId)) return;
        next = toggled;
      } else if (!selection.has(shapeId)) {
        next = new Set([shapeId]);
        onSelectionChange(next);
      }
      const originals = new Map<ShapeId, Point>();
      for (const id of next) {
        const shape = shapes.byId.get(id);
        if (shape && isBoxShape(shape)) originals.set(id, { x: shape.x, y: shape.y });
      }
      undoManager.stopCapturing();
      gesture.current = { kind: 'move', origin: world, originals };
      return;
    }

    gesture.current = {
      kind: 'marquee',
      origin: world,
      base: event.shiftKey ? selection : new Set(),
    };
    if (!event.shiftKey) select([]);
    setPreview({ kind: 'marquee', rect: rectFromPoints(world, world) });
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const world = toWorld(event);
    broadcastCursor(world);
    const current = gesture.current;
    if (!current) return;

    switch (current.kind) {
      case 'pan': {
        const screen = toScreen(event);
        onViewportChange({
          ...current.start,
          x: current.start.x + screen.x - current.origin.x,
          y: current.start.y + screen.y - current.origin.y,
        });
        break;
      }
      case 'move': {
        const dx = world.x - current.origin.x;
        const dy = world.y - current.origin.y;
        const patches = new Map(
          [...current.originals].map(([id, p]) => [
            id,
            { x: Math.round(p.x + dx), y: Math.round(p.y + dy) },
          ]),
        );
        updateShapes(doc, patches, localOrigin);
        break;
      }
      case 'resize': {
        const delta = { x: world.x - current.origin.x, y: world.y - current.origin.y };
        updateShape(
          doc,
          current.id,
          resizeRect(current.original, current.handle, delta),
          localOrigin,
        );
        break;
      }
      case 'marquee': {
        const rect = rectFromPoints(current.origin, world);
        setPreview({ kind: 'marquee', rect });
        const hits = boxes.filter((shape) => intersects(rect, shape)).map((shape) => shape.id);
        select([...current.base, ...hits]);
        break;
      }
      case 'connect':
        setPreview((prev) => (prev?.kind === 'connect' ? { ...prev, to: world } : prev));
        break;
    }
  }

  function handlePointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const current = gesture.current;
    gesture.current = null;
    setPreview(null);
    if (svgRef.current?.hasPointerCapture?.(event.pointerId)) {
      svgRef.current.releasePointerCapture(event.pointerId);
    }
    if (pendingEdit.current) {
      onEditingChange(pendingEdit.current);
      pendingEdit.current = null;
    }
    if (!current) return;

    if (current.kind === 'move' || current.kind === 'resize') {
      // Close the undo group so the next gesture is its own undo step.
      undoManager.stopCapturing();
    } else if (current.kind === 'connect') {
      const target = hitTest(boxes, toWorld(event));
      if (target && target.id !== current.fromId) {
        const connector = makeConnector(current.fromId, target.id, {
          createdBy: user.id,
          zIndex: nextZIndex(doc),
        });
        addShape(doc, connector, localOrigin);
        undoManager.stopCapturing();
        select([connector.id]);
      }
      onToolChange('select');
    }
  }

  function handleDoubleClick(event: ReactMouseEvent<SVGSVGElement>) {
    const shapeId = closestData(event.target, 'data-shape-id');
    const shape = shapeId ? shapes.byId.get(shapeId) : undefined;
    if (shape?.kind === 'sticky') {
      select([shape.id]);
      onEditingChange(shape.id);
    } else if (!shapeId && tool === 'select') {
      const sticky = createBox('sticky', toWorld(event));
      onEditingChange(sticky.id);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<SVGSVGElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const shapeId = closestData(event.target, 'data-shape-id');
    if (!shapeId) return;
    event.preventDefault();
    const shape = shapes.byId.get(shapeId);
    if (event.key === 'Enter' && shape?.kind === 'sticky' && selection.has(shapeId)) {
      onEditingChange(shapeId);
    } else if (event.shiftKey) {
      const toggled = new Set(selection);
      if (toggled.has(shapeId)) toggled.delete(shapeId);
      else toggled.add(shapeId);
      onSelectionChange(toggled);
    } else {
      select([shapeId]);
    }
  }

  const editing = editingId ? shapes.byId.get(editingId) : undefined;
  const transform = `translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`;
  const gridSize = 24;

  return (
    <div className={styles.container}>
      <svg
        ref={svgRef}
        className={styles.canvas}
        data-tool={tool}
        data-panning={spaceHeld || undefined}
        role="application"
        aria-label="Whiteboard canvas"
        aria-describedby={`${ids}-help`}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={() => broadcastCursor(null)}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      >
        <defs>
          <pattern
            id={gridId}
            width={gridSize}
            height={gridSize}
            patternUnits="userSpaceOnUse"
            patternTransform={transform}
          >
            <circle cx={1} cy={1} r={1} className={styles.gridDot} />
          </pattern>
          <marker
            id={arrowId}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={8}
            markerHeight={8}
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
          </marker>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${gridId})`} />
        <g transform={transform}>
          {connectors.map((connector) => {
            const from = shapes.byId.get(connector.fromId);
            const to = shapes.byId.get(connector.toId);
            if (!from || !to || !isBoxShape(from) || !isBoxShape(to)) return null;
            return (
              <ConnectorView
                key={connector.id}
                connector={connector}
                from={from}
                to={to}
                selected={selection.has(connector.id)}
                markerId={arrowId}
              />
            );
          })}
          {boxes.map((shape) => (
            <ShapeView
              key={shape.id}
              shape={shape}
              selected={selection.has(shape.id)}
              editing={shape.id === editingId}
            />
          ))}
          <RemoteSelections peers={peers} byId={shapes.byId} zoom={viewport.zoom} />
          <SelectionOverlay
            shapes={selectedBoxes}
            zoom={viewport.zoom}
            showHandles={selectedBoxes.length === 1 && tool === 'select' && !editingId}
          />
          {editing?.kind === 'sticky' && (
            <StickyEditor
              key={editing.id}
              shape={editing}
              onChange={(text) => updateShape(doc, editing.id, { text }, localOrigin)}
              onClose={() => onEditingChange(null)}
            />
          )}
          {preview?.kind === 'marquee' && (
            <MarqueePreview rect={preview.rect} zoom={viewport.zoom} />
          )}
          {preview?.kind === 'connect' && (
            <line
              x1={preview.from.x}
              y1={preview.from.y}
              x2={preview.to.x}
              y2={preview.to.y}
              className={styles.connectPreview}
              strokeWidth={2 / viewport.zoom}
            />
          )}
          <RemoteCursors peers={peers} zoom={viewport.zoom} />
        </g>
      </svg>
      <p id={`${ids}-help`} className="visually-hidden">
        Use the toolbar or shortcut keys to pick a tool, then click the canvas to place a shape. Tab
        moves between shapes, Enter selects, arrow keys nudge, Delete removes. Double-click or press
        Enter on a selected sticky note to edit it. Hold Space and drag, or scroll, to pan; Ctrl and
        scroll to zoom.
      </p>
    </div>
  );
}
