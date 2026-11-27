import type { RoomRole } from '@canvas-collab/shared';
import { CollabProvider } from '@canvas-collab/shared/client';
import { pino } from 'pino';
import * as Y from 'yjs';
import { type ServerConfig, loadConfig } from '../src/config';
import { MemoryStore, type DocumentStore } from '../src/persistence';
import { type App, createApp } from '../src/server';

export const silentLogger = pino({ level: 'silent' });

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    ...loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'test-secret-that-is-at-least-32-characters' }),
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    ...overrides,
  };
}

export interface TestServer {
  app: App;
  store: DocumentStore;
  wsUrl: string;
  httpUrl: string;
  token(roomId: string, options?: { userId?: string; role?: RoomRole }): Promise<string>;
  connect(roomId: string, options?: { doc?: Y.Doc; role?: RoomRole }): CollabProvider;
  close(): Promise<void>;
}

export async function startTestServer(
  overrides: Partial<ServerConfig> = {},
  store: DocumentStore = new MemoryStore(),
): Promise<TestServer> {
  const app = createApp({ config: testConfig(overrides), logger: silentLogger, store });
  const { port } = await app.listen();
  const providers: CollabProvider[] = [];

  const token = async (
    roomId: string,
    { userId = 'user', role = 'editor' }: { userId?: string; role?: RoomRole } = {},
  ) => (await app.tokens.sign({ sub: userId, name: userId, room: roomId, role })).token;

  return {
    app,
    store,
    wsUrl: `ws://127.0.0.1:${port}`,
    httpUrl: `http://127.0.0.1:${port}`,
    token,
    connect(roomId, { doc = new Y.Doc(), role = 'editor' } = {}) {
      const provider = new CollabProvider({
        serverUrl: `ws://127.0.0.1:${port}`,
        roomId,
        doc,
        getToken: () => token(roomId, { userId: `u${doc.clientID}`, role }),
        backoff: { initialDelayMs: 10, maxDelayMs: 50 },
      });
      providers.push(provider);
      return provider;
    },
    async close() {
      for (const provider of providers) provider.destroy();
      await app.close();
    },
  };
}

/** Polls until `predicate` holds; fails with a useful message instead of a bare timeout. */
export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5_000, message = 'condition' }: { timeoutMs?: number; message?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function waitForSynced(provider: CollabProvider): Promise<void> {
  return waitFor(() => provider.synced, { message: `provider ${provider.doc.clientID} to sync` });
}
