import type { Dispatch, SetStateAction } from 'react';
import {
  IDENTITY_VIEWPORT,
  type Viewport,
  ZOOM_STEP,
  zoomAroundWindowCenter,
} from '../lib/geometry';
import styles from './ZoomControls.module.css';

export interface ZoomControlsProps {
  viewport: Viewport;
  onViewportChange: Dispatch<SetStateAction<Viewport>>;
}

export function ZoomControls({ viewport, onViewportChange }: ZoomControlsProps) {
  return (
    <div className={styles.zoom} role="group" aria-label="Zoom">
      <button
        type="button"
        className={styles.button}
        aria-label="Zoom out"
        aria-keyshortcuts="-"
        onClick={() => onViewportChange((vp) => zoomAroundWindowCenter(vp, 1 / ZOOM_STEP))}
      >
        −
      </button>
      <button
        type="button"
        className={styles.level}
        aria-label="Reset zoom"
        aria-keyshortcuts="0"
        title="Reset view (0)"
        onClick={() => onViewportChange(IDENTITY_VIEWPORT)}
      >
        <output aria-live="off">{Math.round(viewport.zoom * 100)}%</output>
      </button>
      <button
        type="button"
        className={styles.button}
        aria-label="Zoom in"
        aria-keyshortcuts="+"
        onClick={() => onViewportChange((vp) => zoomAroundWindowCenter(vp, ZOOM_STEP))}
      >
        +
      </button>
    </div>
  );
}
