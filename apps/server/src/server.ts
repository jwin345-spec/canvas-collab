import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  CloseCode,
  type HealthResponse,
  ROOM_PATH_PREFIX,
  RoomIdSchema,
  type RoomTokenClaims,
  TokenRequestSchema,
  type TokenResponse,
  createId,
} from '@canvas-collab/shared';
import { WebSocketServer } from 'ws';
import { AuthError, TokenService, canAccessRoom } from './auth';
import type { ServerConfig } from './config';
import { Connection } from './connection';
import type { Logger } from './logger';
import type { DocumentStore } from './persistence';
import { RoomManager } from './roomManager';

export interface AppDependencies {
  config: ServerConfig;
  logger: Logger;
  store: DocumentStore;
}

export interface App {
  readonly httpServer: Server;
  readonly rooms: RoomManager;
  readonly tokens: TokenService;
  listen(): Promise<AddressInfo>;
  /** Stops accepting work, disconnects clients and persists every room. Idempotent. */
  close(): Promise<void>;
}

const MAX_JSON_BODY_BYTES = 4 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** Rejects an upgrade with a plain HTTP response before any WebSocket resources exist. */
function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (!socket.writable) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
}

export function createApp({ config, logger, store }: AppDependencies): App {
  const startedAt = Date.now();
  const tokens = new TokenService(config.jwtSecret, config.tokenTtlSeconds);
  const rooms = new RoomManager({
    store,
    logger,
    compactionThreshold: config.compactionUpdateThreshold,
    compactionIntervalMs: config.compactionIntervalMs,
    idleTtlMs: config.roomIdleTtlMs,
  });
  const connections = new Set<Connection>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });
  let shuttingDown = false;
  let closing: Promise<void> | null = null;

  async function handleTokenRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsed = TokenRequestSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'bad request');
    const { roomId, name, role } = parsed.data;
    const userId = parsed.data.userId ?? createId();
    const { token, expiresAt } = await tokens.sign({ sub: userId, name, room: roomId, role });
    const body: TokenResponse = { token, expiresAt, userId };
    sendJson(res, 200, body);
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://internal');
    res.setHeader('access-control-allow-origin', config.corsOrigin);
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/healthz' && req.method === 'GET') {
      const body: HealthResponse = {
        status: shuttingDown ? 'shutting_down' : 'ok',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        rooms: rooms.roomCount,
        connections: connections.size,
        persistence: store.kind,
      };
      sendJson(res, shuttingDown ? 503 : 200, body);
      return;
    }
    if (url.pathname === '/api/token' && req.method === 'POST' && config.allowDevTokens) {
      await handleTokenRequest(req, res);
      return;
    }
    throw new HttpError(404, 'not found');
  }

  const httpServer = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) logger.error({ err: error, url: req.url }, 'request failed');
      if (!res.headersSent) sendJson(res, status, { error: (error as Error).message });
    });
  });

  async function authenticateUpgrade(
    req: IncomingMessage,
  ): Promise<{ roomId: string; claims: RoomTokenClaims }> {
    const url = new URL(req.url ?? '/', 'http://internal');
    if (!url.pathname.startsWith(ROOM_PATH_PREFIX)) throw new HttpError(404, 'Not Found');
    let rawRoomId: string;
    try {
      rawRoomId = decodeURIComponent(url.pathname.slice(ROOM_PATH_PREFIX.length));
    } catch {
      throw new HttpError(400, 'Bad Request');
    }
    const roomId = RoomIdSchema.safeParse(rawRoomId);
    if (!roomId.success) throw new HttpError(400, 'Bad Request');

    const token = url.searchParams.get('token');
    if (!token) throw new HttpError(401, 'Unauthorized');
    const claims = await tokens.verify(token);
    if (!canAccessRoom(claims, roomId.data)) throw new HttpError(403, 'Forbidden');
    return { roomId: roomId.data, claims };
  }

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', (error) => logger.debug({ err: error }, 'upgrade socket error'));
    if (shuttingDown) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    authenticateUpgrade(req)
      .then(({ roomId, claims }) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          const conn = new Connection(
            ws,
            { userId: claims.sub, name: claims.name, role: claims.role },
            { maxBufferedBytes: config.maxBufferedBytes, logger: logger.child({ roomId }) },
          );
          connections.add(conn);
          conn.onClose((code) => {
            connections.delete(conn);
            conn.logger.debug({ code }, 'connection closed');
          });
          rooms.join(roomId, conn).catch((error: unknown) => {
            conn.logger.error({ err: error }, 'failed to load room');
            conn.close(CloseCode.InternalError, 'room unavailable');
          });
        });
      })
      .catch((error: unknown) => {
        if (error instanceof HttpError) {
          rejectUpgrade(socket, error.status, error.message);
        } else if (error instanceof AuthError) {
          logger.info({ reason: error.reason }, 'rejected unauthenticated upgrade');
          rejectUpgrade(socket, 401, 'Unauthorized');
        } else {
          logger.error({ err: error }, 'upgrade failed');
          rejectUpgrade(socket, 500, 'Internal Server Error');
        }
      });
  });

  const heartbeat = setInterval(() => {
    for (const conn of connections) conn.heartbeat();
  }, config.heartbeatIntervalMs);
  heartbeat.unref();

  return {
    httpServer,
    rooms,
    tokens,

    listen() {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, config.host, () => {
          httpServer.off('error', reject);
          rooms.startCompactionLoop();
          const address = httpServer.address() as AddressInfo;
          logger.info(
            { host: address.address, port: address.port, persistence: store.kind },
            'sync server listening',
          );
          resolve(address);
        });
      });
    },

    close() {
      closing ??= (async () => {
        shuttingDown = true;
        clearInterval(heartbeat);
        const httpClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
        await rooms.shutdown();
        for (const conn of connections) conn.terminate();
        wss.close();
        httpServer.closeAllConnections();
        await httpClosed;
        logger.info('sync server stopped');
      })();
      return closing;
    },
  };
}
