import { type BoxShape, type Shape, isBoxShape } from '@canvas-collab/shared';
import { memo, useEffect, useRef } from 'react';
import { type Rect, RESIZE_HANDLES, boundsOf, handlePosition } from '../lib/geometry';
import type { Peer } from '../hooks/useAwarenessPeers';
import styles from './Overlays.module.css';

const HANDLE_SIZE = 10;

interface SelectionOverlayProps {
  shapes: readonly BoxShape[];
  zoom: number;
  showHandles: boolean;
}

/** Bounding box of the local selection plus resize handles when one shape is selected. */
export function SelectionOverlay({ shapes, zoom, showHandles }: SelectionOverlayProps) {
  const bounds = boundsOf(shapes);
  if (!bounds) return null;
  const size = HANDLE_SIZE / zoom;
  return (
    <g className={styles.selection} aria-hidden="true">
      <rect
        x={bounds.x}
        y={bounds.y}
        width={bounds.width}
        height={bounds.height}
        className={styles.selectionBox}
        strokeWidth={1.5 / zoom}
      />
      {showHandles &&
        RESIZE_HANDLES.map((handle) => {
          const p = handlePosition(bounds, handle);
          return (
            <rect
              key={handle}
              data-handle={handle}
              className={styles.handle}
              style={{ cursor: `${handle}-resize` }}
              x={p.x - size / 2}
              y={p.y - size / 2}
              width={size}
              height={size}
              strokeWidth={1.5 / zoom}
            />
          );
        })}
    </g>
  );
}

interface RemotePresenceProps {
  peers: readonly Peer[];
  byId: ReadonlyMap<string, Shape>;
  zoom: number;
}

/** Collaborators' selections, outlined in their colour. */
export const RemoteSelections = memo(function RemoteSelections({
  peers,
  byId,
  zoom,
}: RemotePresenceProps) {
  return (
    <g aria-hidden="true" className={styles.remote}>
      {peers.flatMap((peer) =>
        peer.state.selection.map((id) => {
          const shape = byId.get(id);
          if (!shape || !isBoxShape(shape)) return null;
          const pad = 4 / zoom;
          return (
            <rect
              key={`${peer.clientId}:${id}`}
              x={shape.x - pad}
              y={shape.y - pad}
              width={shape.width + pad * 2}
              height={shape.height + pad * 2}
              fill="none"
              stroke={peer.state.user.color}
              strokeWidth={2 / zoom}
              strokeDasharray={`${6 / zoom} ${4 / zoom}`}
            />
          );
        }),
      )}
    </g>
  );
});

/** Collaborators' cursors. Drawn at constant screen size regardless of zoom. */
export const RemoteCursors = memo(function RemoteCursors({
  peers,
  zoom,
}: Omit<RemotePresenceProps, 'byId'>) {
  return (
    <g aria-hidden="true" className={styles.remote}>
      {peers.map(({ clientId, state }) =>
        state.cursor ? (
          <g
            key={clientId}
            data-testid="remote-cursor"
            className={styles.cursor}
            transform={`translate(${state.cursor.x} ${state.cursor.y}) scale(${1 / zoom})`}
          >
            <path
              d="M0 0 L0 17 L4.5 12.5 L8 20 L11 18.5 L7.5 11.5 L13 11.5 Z"
              fill={state.user.color}
              stroke="#fff"
              strokeWidth={1.2}
            />
            <foreignObject x={14} y={16} width={160} height={28}>
              <span className={styles.cursorLabel} style={{ background: state.user.color }}>
                {state.user.name}
              </span>
            </foreignObject>
          </g>
        ) : null,
      )}
    </g>
  );
});

interface PreviewProps {
  rect: Rect;
  zoom: number;
}

export function MarqueePreview({ rect, zoom }: PreviewProps) {
  return <rect {...rect} className={styles.marquee} strokeWidth={1 / zoom} aria-hidden="true" />;
}

interface StickyEditorProps {
  shape: Extract<BoxShape, { kind: 'sticky' }>;
  onChange: (text: string) => void;
  onClose: () => void;
}

/** Inline editor for a sticky note. Writes through to the doc so collaborators see typing live. */
export function StickyEditor({ shape, onChange, onClose }: StickyEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  return (
    <foreignObject x={shape.x} y={shape.y} width={shape.width} height={shape.height}>
      <textarea
        ref={ref}
        className={styles.stickyEditor}
        aria-label="Sticky note text"
        value={shape.text}
        maxLength={10_000}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onClose}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (
            event.key === 'Escape' ||
            (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
          ) {
            event.preventDefault();
            onClose();
          }
        }}
      />
    </foreignObject>
  );
}
