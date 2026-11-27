import { type RoomId, type RoomTokenClaims, RoomTokenClaimsSchema } from '@canvas-collab/shared';
import { SignJWT, errors as joseErrors, jwtVerify } from 'jose';

const ISSUER = 'canvas-collab';
const AUDIENCE = 'canvas-collab:rooms';
const ALGORITHM = 'HS256';

export class AuthError extends Error {
  override readonly name = 'AuthError';
  constructor(
    message: string,
    readonly reason: 'expired' | 'invalid',
  ) {
    super(message);
  }
}

export interface SignedToken {
  token: string;
  /** Expiry as a Unix timestamp in milliseconds. */
  expiresAt: number;
}

/**
 * Issues and verifies HS256 room tokens. In a real deployment tokens would be minted by the
 * product's auth service; the sync server only needs `verify`.
 */
export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlSeconds: number,
    private readonly now: () => number = Date.now,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(claims: RoomTokenClaims): Promise<SignedToken> {
    const { sub, ...rest } = RoomTokenClaimsSchema.parse(claims);
    const issuedAt = Math.floor(this.now() / 1000);
    const expiresAtSeconds = issuedAt + this.ttlSeconds;
    const token = await new SignJWT(rest)
      .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
      .setSubject(sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAtSeconds)
      .sign(this.key);
    return { token, expiresAt: expiresAtSeconds * 1000 };
  }

  async verify(token: string): Promise<RoomTokenClaims> {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
        currentDate: new Date(this.now()),
      }));
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) throw new AuthError('token expired', 'expired');
      throw new AuthError('token rejected', 'invalid');
    }
    const claims = RoomTokenClaimsSchema.safeParse(payload);
    if (!claims.success) throw new AuthError('token claims malformed', 'invalid');
    return claims.data;
  }
}

export function canAccessRoom(claims: RoomTokenClaims, roomId: RoomId): boolean {
  return claims.room === '*' || claims.room === roomId;
}
