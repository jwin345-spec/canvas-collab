import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  boundsOf,
  connectorEndpoints,
  edgePoint,
  hitTest,
  intersects,
  rectFromPoints,
  resizeRect,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from '../src/lib/geometry';
import { comboFor } from '../src/hooks/useKeyboardShortcuts';
import { initials } from '../src/lib/identity';
import { makeBoxShape } from '@canvas-collab/shared';

describe('viewport math', () => {
  const viewport = { x: 100, y: 50, zoom: 2 };

  it('converts between screen and world space', () => {
    const world = { x: 10, y: 20 };
    expect(worldToScreen(world, viewport)).toEqual({ x: 120, y: 90 });
    expect(screenToWorld(worldToScreen(world, viewport), viewport)).toEqual(world);
  });

  it('keeps the anchor fixed while zooming', () => {
    const anchor = { x: 300, y: 200 };
    const before = screenToWorld(anchor, viewport);
    const zoomed = zoomAt(viewport, anchor, 3);
    expect(screenToWorld(anchor, zoomed)).toEqual(before);
  });

  it('clamps zoom', () => {
    expect(zoomAt(viewport, { x: 0, y: 0 }, 100).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(viewport, { x: 0, y: 0 }, 0.001).zoom).toBe(MIN_ZOOM);
  });
});

describe('rect helpers', () => {
  it('normalises rectangles from any two corners', () => {
    expect(rectFromPoints({ x: 10, y: 10 }, { x: 0, y: 30 })).toEqual({
      x: 0,
      y: 10,
      width: 10,
      height: 20,
    });
  });

  it('detects intersections and computes bounds', () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    expect(intersects(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(intersects(a, { x: 11, y: 0, width: 5, height: 5 })).toBe(false);
    expect(boundsOf([a, { x: 20, y: -5, width: 5, height: 5 }])).toEqual({
      x: 0,
      y: -5,
      width: 25,
      height: 15,
    });
    expect(boundsOf([])).toBeNull();
  });

  it('hit-tests the topmost shape', () => {
    const below = makeBoxShape(
      'rect',
      { x: 50, y: 50 },
      { createdBy: 'u', zIndex: 1, id: 'below' },
    );
    const above = makeBoxShape(
      'rect',
      { x: 60, y: 60 },
      { createdBy: 'u', zIndex: 2, id: 'above' },
    );
    expect(hitTest([below, above], { x: 60, y: 60 })?.id).toBe('above');
    expect(hitTest([below, above], { x: 5000, y: 0 })).toBeNull();
  });
});

describe('resizeRect', () => {
  const original = { x: 100, y: 100, width: 200, height: 100 };

  it('grows from the south-east corner', () => {
    expect(resizeRect(original, 'se', { x: 50, y: 20 })).toEqual({
      x: 100,
      y: 100,
      width: 250,
      height: 120,
    });
  });

  it('anchors the opposite edge when dragging north-west', () => {
    expect(resizeRect(original, 'nw', { x: 50, y: 20 })).toEqual({
      x: 150,
      y: 120,
      width: 150,
      height: 80,
    });
  });

  it('never shrinks below the minimum size', () => {
    const result = resizeRect(original, 'w', { x: 1_000, y: 0 }, 24);
    expect(result.width).toBe(24);
    expect(result.x + result.width).toBe(original.x + original.width);
  });
});

describe('connector geometry', () => {
  it('attaches to the border facing the other shape', () => {
    const rect = { x: 0, y: 0, width: 100, height: 50 };
    expect(edgePoint(rect, { x: 500, y: 25 })).toEqual({ x: 100, y: 25 });
    expect(edgePoint(rect, { x: 50, y: -500 })).toEqual({ x: 50, y: 0 });
  });

  it('computes both endpoints', () => {
    const left = { x: 0, y: 0, width: 100, height: 100 };
    const right = { x: 300, y: 0, width: 100, height: 100 };
    expect(connectorEndpoints(left, right)).toEqual({
      start: { x: 100, y: 50 },
      end: { x: 300, y: 50 },
    });
  });
});

describe('misc helpers', () => {
  it('normalises keyboard combos', () => {
    expect(
      comboFor(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true })),
    ).toBe('mod+shift+z');
    expect(comboFor(new KeyboardEvent('keydown', { key: 'Delete' }))).toBe('delete');
    expect(comboFor(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))).toBe('mod+z');
  });

  it('derives initials', () => {
    expect(initials('Swift Otter')).toBe('SO');
    expect(initials('ada')).toBe('A');
  });
});
