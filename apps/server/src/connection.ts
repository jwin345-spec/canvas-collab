import { CloseCode, type RoomRole } from '@canvas-collab/shared';
import { type RawData, WebSocket } from 'ws';
import type { Logger } from './logger';

export interface ConnectionIdentity {
  userId: string;
  name: string;
  role: RoomRole;
}

export interface ConnectionOptions {
  /** Close the socket once this many bytes are waiting in its send buffer. */
  maxBufferedBytes: number;
  logger: Logger;
}

let nextConnectionId = 1;

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

/**
 * One client socket. Wraps `ws` with the policies the room logic should not care about:
 *
 * - Heartbeat: `heartbeat()` is called on a fixed interval; a client that did not answer
 *   the previous ping is terminated, which reclaims half-open TCP connections.
 * - Backpressure: if a client cannot drain its send buffer we disconnect it rather than
 *   buffer without bound. Dropping individual CRDT updates would corrupt its replica; on
 *   reconnect it resyncs with a single state-vector diff, which is cheaper than replaying
 *   the backlog anyway.
 * - Messages that arrive before the room has finished loading are buffered and replayed.
 */
export class Connection {
  readonly id = nextConnectionId++;
  readonly logger: Logger;
  private alive = true;
  private handler: ((data: Uint8Array) => void) | null = null;
  private pending: Uint8Array[] = [];
  private readonly closeListeners: ((code: number) => void)[] = [];

  constructor(
    private readonly ws: WebSocket,
    readonly identity: ConnectionIdentity,
    private readonly options: ConnectionOptions,
  ) {
    this.logger = options.logger.child({ connId: this.id, userId: identity.userId });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.close(CloseCode.UnsupportedData, 'binary frames only');
        return;
      }
      const bytes = toBytes(data);
      if (this.handler) this.handler(bytes);
      else this.pending.push(bytes);
    });
    ws.on('pong', () => {
      this.alive = true;
    });
    ws.on('error', (error) => this.logger.warn({ err: error }, 'socket error'));
    ws.on('close', (code) => {
      this.pending = [];
      this.handler = null;
      for (const listener of this.closeListeners) listener(code);
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  get readOnly(): boolean {
    return this.identity.role === 'viewer';
  }

  /** Routes inbound frames to `handler`, replaying anything received before it was set. */
  setMessageHandler(handler: (data: Uint8Array) => void): void {
    this.handler = handler;
    const queued = this.pending;
    this.pending = [];
    for (const data of queued) handler(data);
  }

  onClose(listener: (code: number) => void): void {
    this.closeListeners.push(listener);
  }

  send(data: Uint8Array): void {
    if (!this.isOpen) return;
    if (this.ws.bufferedAmount > this.options.maxBufferedBytes) {
      this.logger.warn(
        { bufferedBytes: this.ws.bufferedAmount },
        'client too slow to drain, disconnecting',
      );
      this.close(CloseCode.TryAgainLater, 'backpressure');
      return;
    }
    this.ws.send(data, (error) => {
      if (error) {
        this.logger.warn({ err: error }, 'send failed, terminating');
        this.ws.terminate();
      }
    });
  }

  /** Returns false (and terminates the socket) if the previous ping went unanswered. */
  heartbeat(): boolean {
    if (!this.alive) {
      this.logger.info('heartbeat missed, terminating connection');
      this.ws.terminate();
      return false;
    }
    this.alive = false;
    this.ws.ping();
    return true;
  }

  close(code: number, reason: string): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(code, reason);
    }
  }

  terminate(): void {
    this.ws.terminate();
  }
}
