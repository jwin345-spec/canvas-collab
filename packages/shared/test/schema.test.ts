import { describe, expect, it } from 'vitest';
import {
  PRESENCE_COLORS,
  PresenceStateSchema,
  RoomIdSchema,
  RoomTokenClaimsSchema,
  ShapeSchema,
  TokenRequestSchema,
  colorForUser,
} from '../src';

const sticky = {
  id: 'note1',
  kind: 'sticky',
  x: 10,
  y: 20,
  width: 180,
  height: 160,
  zIndex: 1,
  createdBy: 'u1',
  text: 'hello',
  color: '#fde68a',
};

describe('ShapeSchema', () => {
  it('accepts every shape kind', () => {
    expect(ShapeSchema.parse(sticky)).toEqual(sticky);
    expect(
      ShapeSchema.parse({ ...sticky, kind: 'rect', fill: '#ffffff', stroke: '#000000' }).kind,
    ).toBe('rect');
    expect(
      ShapeSchema.parse({
        id: 'c1',
        kind: 'connector',
        fromId: 'a',
        toId: 'b',
        stroke: '#000000',
        zIndex: 2,
        createdBy: 'u1',
      }).kind,
    ).toBe('connector');
  });

  it.each([
    ['unknown kind', { ...sticky, kind: 'triangle' }],
    ['non-finite coordinate', { ...sticky, x: Number.POSITIVE_INFINITY }],
    ['zero width', { ...sticky, width: 0 }],
    ['bad colour', { ...sticky, color: 'red' }],
    ['bad id', { ...sticky, id: 'has spaces' }],
    ['missing field', { ...sticky, text: undefined }],
  ])('rejects %s', (_label, value) => {
    expect(ShapeSchema.safeParse(value).success).toBe(false);
  });
});

describe('message schemas', () => {
  it('validates room ids', () => {
    expect(RoomIdSchema.safeParse('team-standup_2').success).toBe(true);
    expect(RoomIdSchema.safeParse('../etc/passwd').success).toBe(false);
    expect(RoomIdSchema.safeParse('').success).toBe(false);
    expect(RoomIdSchema.safeParse('x'.repeat(65)).success).toBe(false);
  });

  it('defaults token requests to the editor role and trims names', () => {
    expect(TokenRequestSchema.parse({ roomId: 'r1', name: '  Ada  ' })).toEqual({
      roomId: 'r1',
      name: 'Ada',
      role: 'editor',
    });
  });

  it('accepts wildcard room claims', () => {
    expect(
      RoomTokenClaimsSchema.parse({ sub: 'u', name: 'n', room: '*', role: 'viewer' }).room,
    ).toBe('*');
  });

  it('validates presence state', () => {
    const state = {
      user: { id: 'u1', name: 'Ada', color: '#3b82f6' },
      cursor: { x: 1, y: 2 },
      selection: ['note1'],
    };
    expect(PresenceStateSchema.parse(state)).toEqual(state);
    expect(PresenceStateSchema.safeParse({ ...state, cursor: { x: 'a' } }).success).toBe(false);
  });
});

describe('colorForUser', () => {
  it('is deterministic and drawn from the palette', () => {
    expect(colorForUser('alice')).toBe(colorForUser('alice'));
    expect(PRESENCE_COLORS).toContain(colorForUser('bob'));
  });
});
