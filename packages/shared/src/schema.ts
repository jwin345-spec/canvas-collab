import { z } from 'zod';

/**
 * Board entities as they are stored in the shared Y.Doc.
 *
 * Every value read out of the CRDT is validated against these schemas: the document is
 * written by untrusted peers, so a malformed shape must be skipped rather than crash
 * every client that renders it.
 */

export const SHAPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const ShapeIdSchema = z.string().regex(SHAPE_ID_PATTERN, 'invalid shape id');
export type ShapeId = z.infer<typeof ShapeIdSchema>;

const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb color');
const FiniteNumber = z.number().finite();
const PositiveDimension = z.number().finite().min(1).max(100_000);

export const STICKY_COLORS = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#ddd6fe'] as const;
export const SHAPE_FILLS = ['#ffffff', '#e0f2fe', '#dcfce7', '#fef3c7', '#fce7f3'] as const;
export const STROKE_COLOR = '#1f2937';

const BoxBaseSchema = z.object({
  id: ShapeIdSchema,
  x: FiniteNumber,
  y: FiniteNumber,
  width: PositiveDimension,
  height: PositiveDimension,
  zIndex: FiniteNumber,
  createdBy: z.string().max(64),
});

export const StickyNoteSchema = BoxBaseSchema.extend({
  kind: z.literal('sticky'),
  text: z.string().max(10_000),
  color: HexColorSchema,
});

export const RectangleSchema = BoxBaseSchema.extend({
  kind: z.literal('rect'),
  fill: HexColorSchema,
  stroke: HexColorSchema,
});

export const EllipseSchema = BoxBaseSchema.extend({
  kind: z.literal('ellipse'),
  fill: HexColorSchema,
  stroke: HexColorSchema,
});

/** A connector has no geometry of its own: its endpoints are derived from the shapes it joins. */
export const ConnectorSchema = z.object({
  id: ShapeIdSchema,
  kind: z.literal('connector'),
  fromId: ShapeIdSchema,
  toId: ShapeIdSchema,
  stroke: HexColorSchema,
  zIndex: FiniteNumber,
  createdBy: z.string().max(64),
});

export const ShapeSchema = z.discriminatedUnion('kind', [
  StickyNoteSchema,
  RectangleSchema,
  EllipseSchema,
  ConnectorSchema,
]);

export type StickyNote = z.infer<typeof StickyNoteSchema>;
export type Rectangle = z.infer<typeof RectangleSchema>;
export type Ellipse = z.infer<typeof EllipseSchema>;
export type Connector = z.infer<typeof ConnectorSchema>;
export type Shape = z.infer<typeof ShapeSchema>;
export type ShapeKind = Shape['kind'];
export type BoxShape = Exclude<Shape, Connector>;

export function isBoxShape(shape: Shape): shape is BoxShape {
  return shape.kind !== 'connector';
}

/** Fields of a box shape that may be patched after creation. */
export type BoxPatch = Partial<
  Pick<BoxShape, 'x' | 'y' | 'width' | 'height' | 'zIndex'> & {
    text: string;
    color: string;
    fill: string;
  }
>;

// ---------------------------------------------------------------------------
// Presence (y-protocols awareness state)
// ---------------------------------------------------------------------------

export const PresenceUserSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(40),
  color: HexColorSchema,
});
export type PresenceUser = z.infer<typeof PresenceUserSchema>;

export const PointSchema = z.object({ x: FiniteNumber, y: FiniteNumber });
export type Point = z.infer<typeof PointSchema>;

export const PresenceStateSchema = z.object({
  user: PresenceUserSchema,
  cursor: PointSchema.nullable(),
  selection: z.array(ShapeIdSchema).max(1_000),
});
export type PresenceState = z.infer<typeof PresenceStateSchema>;

export const PRESENCE_COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
] as const;

/** Deterministically maps a user id to a presence colour so a user keeps their colour across reloads. */
export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length] ?? PRESENCE_COLORS[0];
}
