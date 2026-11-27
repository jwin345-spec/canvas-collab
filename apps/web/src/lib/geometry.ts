import type { BoxShape, Point } from '@canvas-collab/shared';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Maps world coordinates to screen: screen = world * zoom + offset. */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 4;
export const MIN_SHAPE_SIZE = 24;

export const IDENTITY_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function screenToWorld(point: Point, viewport: Viewport): Point {
  return { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom };
}

export function worldToScreen(point: Point, viewport: Viewport): Point {
  return { x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y };
}

/** Zooms to `zoom` while keeping the world point under `anchor` (screen space) fixed. */
export function zoomAt(viewport: Viewport, anchor: Point, zoom: number): Viewport {
  const nextZoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const world = screenToWorld(anchor, viewport);
  return {
    zoom: nextZoom,
    x: anchor.x - world.x * nextZoom,
    y: anchor.y - world.y * nextZoom,
  };
}

export const ZOOM_STEP = 1.2;

/** Zooms by `factor` around the centre of the window so the content in the middle stays put. */
export function zoomAroundWindowCenter(viewport: Viewport, factor: number): Viewport {
  const anchor = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  return zoomAt(viewport, anchor, viewport.zoom * factor);
}

/** Rectangle spanned by two arbitrary corner points. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

export function containsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function center(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Topmost box shape under `point`; `shapes` must be in paint order (back to front). */
export function hitTest(shapes: readonly BoxShape[], point: Point): BoxShape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i];
    if (shape && containsPoint(shape, point)) return shape;
  }
  return null;
}

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * Applies a drag of `delta` on `handle` to `original`. The opposite edge stays anchored and
 * dimensions never drop below `minSize` (the moving edge stops instead of flipping).
 */
export function resizeRect(
  original: Rect,
  handle: ResizeHandle,
  delta: Point,
  minSize = MIN_SHAPE_SIZE,
): Rect {
  let { x, y, width, height } = original;
  if (handle.includes('e')) width = Math.max(minSize, original.width + delta.x);
  if (handle.includes('s')) height = Math.max(minSize, original.height + delta.y);
  if (handle.includes('w')) {
    width = Math.max(minSize, original.width - delta.x);
    x = original.x + original.width - width;
  }
  if (handle.includes('n')) {
    height = Math.max(minSize, original.height - delta.y);
    y = original.y + original.height - height;
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function handlePosition(rect: Rect, handle: ResizeHandle): Point {
  const xs = { w: rect.x, e: rect.x + rect.width, mid: rect.x + rect.width / 2 };
  const ys = { n: rect.y, s: rect.y + rect.height, mid: rect.y + rect.height / 2 };
  const x = handle.includes('w') ? xs.w : handle.includes('e') ? xs.e : xs.mid;
  const y = handle.includes('n') ? ys.n : handle.includes('s') ? ys.s : ys.mid;
  return { x, y };
}

/**
 * Point where the segment from the centre of `rect` towards `target` leaves the rectangle.
 * Used to attach connectors to shape borders instead of their centres.
 */
export function edgePoint(rect: Rect, target: Point): Point {
  const c = center(rect);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const scale = Math.min(
    dx === 0 ? Infinity : rect.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : rect.height / 2 / Math.abs(dy),
  );
  return { x: c.x + dx * Math.min(scale, 1), y: c.y + dy * Math.min(scale, 1) };
}

export function connectorEndpoints(from: Rect, to: Rect): { start: Point; end: Point } {
  return { start: edgePoint(from, center(to)), end: edgePoint(to, center(from)) };
}
