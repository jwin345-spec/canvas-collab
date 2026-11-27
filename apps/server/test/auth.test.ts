import type { RoomTokenClaims } from '@canvas-collab/shared';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { AuthError, TokenService, canAccessRoom } from '../src/auth';
import { ConfigError, loadConfig } from '../src/config';

const SECRET = 'a-very-long-test-secret-of-at-least-32-chars';
const claims: RoomTokenClaims = { sub: 'u1', name: 'Ada', room: 'design', role: 'editor' };

describe('TokenService', () => {
  it('round-trips claims', async () => {
    const service = new TokenService(SECRET, 60);
    const { token, expiresAt } = await service.sign(claims);
    expect(expiresAt).toBeGreaterThan(Date.now());
    await expect(service.verify(token)).resolves.toEqual(claims);
  });

  it('rejects expired tokens', async () => {
    let now = Date.now();
    const service = new TokenService(SECRET, 60, () => now);
    const { token } = await service.sign(claims);
    now += 61_000;
    await expect(service.verify(token)).rejects.toMatchObject({ reason: 'expired' });
  });

  it('rejects tokens signed with another secret', async () => {
    const { token } = await new TokenService(`${SECRET}-other`, 60).sign(claims);
    await expect(new TokenService(SECRET, 60).verify(token)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects tampered payloads', async () => {
    const service = new TokenService(SECRET, 60);
    const { token } = await service.sign(claims);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...claims, room: '*', iss: 'canvas-collab', aud: 'canvas-collab:rooms' }),
    ).toString('base64url');
    await expect(service.verify(`${header}.${forgedPayload}.${signature}`)).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('rejects unsigned (alg: none) tokens', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    await expect(
      new TokenService(SECRET, 60).verify(`${header}.${payload}.`),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects well-signed tokens with malformed claims', async () => {
    const token = await new SignJWT({ room: 'design' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setIssuer('canvas-collab')
      .setAudience('canvas-collab:rooms')
      .setExpirationTime('1m')
      .sign(new TextEncoder().encode(SECRET));
    await expect(new TokenService(SECRET, 60).verify(token)).rejects.toMatchObject({
      message: 'token claims malformed',
    });
  });
});

describe('canAccessRoom', () => {
  it('matches exact rooms and wildcards', () => {
    expect(canAccessRoom(claims, 'design')).toBe(true);
    expect(canAccessRoom(claims, 'finance')).toBe(false);
    expect(canAccessRoom({ ...claims, room: '*' }, 'finance')).toBe(true);
  });
});

describe('loadConfig', () => {
  it('applies defaults in development', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ port: 1234, persistence: 'auto', allowDevTokens: true });
    expect(config.usingDevSecret).toBe(true);
  });

  it('requires a strong secret in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'short' })).toThrow(/32/);
    const config = loadConfig({ NODE_ENV: 'production', JWT_SECRET: SECRET });
    expect(config).toMatchObject({ allowDevTokens: false, usingDevSecret: false });
  });

  it('reports invalid values', () => {
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow(/PORT/);
  });
});
