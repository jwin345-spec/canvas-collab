import { z } from 'zod';

/**
 * Contracts for everything that crosses the network as JSON: the token endpoint, the JWT
 * claims carried on the WebSocket upgrade, and the health probe. The binary Yjs traffic is
 * described in `protocol.ts`.
 */

export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const RoomIdSchema = z
  .string()
  .regex(ROOM_ID_PATTERN, 'room id must be 1-64 characters of [A-Za-z0-9_-]');
export type RoomId = z.infer<typeof RoomIdSchema>;

export const RoomRoleSchema = z.enum(['editor', 'viewer']);
export type RoomRole = z.infer<typeof RoomRoleSchema>;

/** Claims embedded in a room token. `room: "*"` grants access to every room. */
export const RoomTokenClaimsSchema = z.object({
  sub: z.string().min(1).max(64),
  name: z.string().min(1).max(40),
  room: z.union([RoomIdSchema, z.literal('*')]),
  role: RoomRoleSchema,
});
export type RoomTokenClaims = z.infer<typeof RoomTokenClaimsSchema>;

export const TokenRequestSchema = z.object({
  roomId: RoomIdSchema,
  name: z.string().trim().min(1).max(40),
  userId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  role: RoomRoleSchema.default('editor'),
});
export type TokenRequest = z.input<typeof TokenRequestSchema>;

export const TokenResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.number().int().positive(),
  userId: z.string().min(1),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'shutting_down']),
  uptimeSeconds: z.number().nonnegative(),
  rooms: z.number().int().nonnegative(),
  connections: z.number().int().nonnegative(),
  persistence: z.enum(['sqlite', 'file', 'memory']),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** WebSocket close codes used by the sync server (4000-4999 is the application range). */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  UnsupportedData: 1003,
  InvalidPayload: 1007,
  MessageTooBig: 1009,
  InternalError: 1011,
  TryAgainLater: 1013,
  Unauthorized: 4401,
  Forbidden: 4403,
  RoomNotFound: 4404,
  HeartbeatTimeout: 4408,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];

/** Path under which rooms are served: `/rooms/:roomId?token=...`. */
export const ROOM_PATH_PREFIX = '/rooms/';

export function roomPath(roomId: RoomId): string {
  return `${ROOM_PATH_PREFIX}${encodeURIComponent(roomId)}`;
}
