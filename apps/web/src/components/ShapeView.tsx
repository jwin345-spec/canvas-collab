import type { BoxShape, Connector } from '@canvas-collab/shared';
import { memo } from 'react';
import { type Rect, connectorEndpoints } from '../lib/geometry';
import styles from './ShapeView.module.css';

const KIND_LABELS: Record<BoxShape['kind'], string> = {
  sticky: 'Sticky note',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
};

function describe(shape: BoxShape): string {
  const label = KIND_LABELS[shape.kind];
  return shape.kind === 'sticky' && shape.text ? `${label}: ${shape.text}` : label;
}

interface ShapeViewProps {
  shape: BoxShape;
  selected: boolean;
  /** Hide the static text while the inline editor is showing it. */
  editing: boolean;
}

/**
 * Pure presentation of one box shape. Interaction is handled by the canvas through event
 * delegation on `data-shape-id`, which keeps this component trivially memoisable.
 */
export const ShapeView = memo(function ShapeView({ shape, selected, editing }: ShapeViewProps) {
  const common = {
    'data-shape-id': shape.id,
    'data-shape-kind': shape.kind,
    role: 'button',
    tabIndex: 0,
    'aria-pressed': selected,
    'aria-label': describe(shape),
    className: styles.shape,
  } as const;

  switch (shape.kind) {
    case 'sticky':
      return (
        <g {...common}>
          <rect
            className={styles.stickyBody}
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            rx={6}
            fill={shape.color}
          />
          {!editing && (
            <foreignObject x={shape.x} y={shape.y} width={shape.width} height={shape.height}>
              <div className={styles.stickyText} data-empty={shape.text === '' || undefined}>
                {shape.text || 'Double-click to write'}
              </div>
            </foreignObject>
          )}
        </g>
      );
    case 'rect':
      return (
        <g {...common}>
          <rect
            x={shape.x}
            y={shape.y}
            width={shape.width}
            height={shape.height}
            rx={4}
            fill={shape.fill}
            stroke={shape.stroke}
            strokeWidth={2}
          />
        </g>
      );
    case 'ellipse':
      return (
        <g {...common}>
          <ellipse
            cx={shape.x + shape.width / 2}
            cy={shape.y + shape.height / 2}
            rx={shape.width / 2}
            ry={shape.height / 2}
            fill={shape.fill}
            stroke={shape.stroke}
            strokeWidth={2}
          />
        </g>
      );
  }
});

interface ConnectorViewProps {
  connector: Connector;
  from: Rect;
  to: Rect;
  selected: boolean;
  markerId: string;
}

export const ConnectorView = memo(function ConnectorView({
  connector,
  from,
  to,
  selected,
  markerId,
}: ConnectorViewProps) {
  const { start, end } = connectorEndpoints(from, to);
  const d = `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  return (
    <g
      data-shape-id={connector.id}
      data-shape-kind="connector"
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label="Connector"
      className={styles.connector}
      data-selected={selected || undefined}
    >
      {/* Wide invisible stroke so a 2px line is still easy to click. */}
      <path d={d} className={styles.connectorHit} />
      <path
        d={d}
        stroke={connector.stroke}
        className={styles.connectorLine}
        markerEnd={`url(#${markerId})`}
      />
    </g>
  );
});
