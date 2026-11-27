import { type PresenceUser, type TokenResponse, TokenResponseSchema } from '@canvas-collab/shared';

/** Refresh tokens this long before they expire so a reconnect never presents a stale one. */
const EXPIRY_MARGIN_MS = 60_000;

export const SERVER_HTTP_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) || '';

export function serverWsUrl(): string {
  const base = SERVER_HTTP_URL || window.location.origin;
  return base.replace(/^http/, 'ws');
}

async function requestToken(roomId: string, user: PresenceUser): Promise<TokenResponse> {
  const response = await fetch(`${SERVER_HTTP_URL}/api/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, name: user.name, userId: user.id }),
  });
  if (!response.ok) throw new Error(`token endpoint responded ${response.status}`);
  return TokenResponseSchema.parse(await response.json());
}

/**
 * Returns a `getToken` function for the provider that caches the current token and only
 * hits the network when it is missing or about to expire.
 */
export function createTokenSource(roomId: string, user: PresenceUser): () => Promise<string> {
  let current: TokenResponse | null = null;
  return async () => {
    if (!current || current.expiresAt - Date.now() < EXPIRY_MARGIN_MS) {
      current = await requestToken(roomId, user);
    }
    return current.token;
  };
}
