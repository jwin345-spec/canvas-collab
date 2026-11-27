import { ObservableV2 } from 'lib0/observable';
import { Awareness, removeAwarenessStates } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { CloseCode, type RoomId, roomPath } from '../messages';
import {
  type AwarenessChange,
  MessageType,
  SyncMessageType,
  changedClients,
  decodeFrame,
  encodeAwarenessUpdate,
  encodeSyncStep1,
  encodeUpdate,
  handleAwarenessPayload,
  handleSyncPayload,
} from '../protocol';
import { type BackoffOptions, DEFAULT_BACKOFF, backoffDelay } from './backoff';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface ConnectionError {
  message: string;
  code?: number;
  reason?: string;
}

// `type` rather than `interface`: ObservableV2 requires an index-compatible event map.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type ProviderEvents = {
  status: (status: ConnectionStatus) => void;
  synced: (synced: boolean) => void;
  'connection-error': (error: ConnectionError) => void;
};

export interface CollabProviderOptions {
  /** Base WebSocket URL of the sync server, e.g. `ws://localhost:1234`. */
  serverUrl: string;
  roomId: RoomId;
  doc: Y.Doc;
  /** Supply to share an Awareness instance; one is created otherwise. */
  awareness?: Awareness;
  /** Called before every (re)connect so expired tokens can be refreshed transparently. */
  getToken: () => string | Promise<string>;
  /** Connect immediately (default true). */
  connect?: boolean;
  /** Close and reconnect if nothing is received for this long (default 30s). */
  livenessTimeoutMs?: number;
  backoff?: Partial<BackoffOptions>;
  /** Injectable for tests and non-browser runtimes; defaults to the global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
}

/** Close codes after which retrying cannot succeed without user intervention. */
const FATAL_CLOSE_CODES = new Set<number>([CloseCode.Forbidden, CloseCode.RoomNotFound]);

/**
 * Client half of the sync protocol. Owns one WebSocket per room and keeps a Y.Doc and an
 * Awareness instance in sync with the server:
 *
 * - On connect it exchanges state vectors (sync step 1/2) so edits made while offline are
 *   merged in both directions; nothing is lost across reconnects.
 * - Local doc and awareness changes are streamed as incremental updates.
 * - Disconnects trigger reconnection with jittered exponential backoff. A liveness timer
 *   detects half-open sockets: the server echoes awareness renewals every ~15s, so
 *   silence for `livenessTimeoutMs` means the connection is dead.
 */
export class CollabProvider extends ObservableV2<ProviderEvents> {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly roomId: RoomId;

  private readonly serverUrl: string;
  private readonly getToken: CollabProviderOptions['getToken'];
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly backoff: BackoffOptions;
  private readonly livenessTimeoutMs: number;
  private readonly ownsAwareness: boolean;

  private socket: WebSocket | null = null;
  private shouldConnect = false;
  private opening = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private _status: ConnectionStatus = 'disconnected';
  private _synced = false;

  constructor(options: CollabProviderOptions) {
    super();
    this.doc = options.doc;
    this.roomId = options.roomId;
    this.serverUrl = options.serverUrl.replace(/\/+$/, '');
    this.getToken = options.getToken;
    this.ownsAwareness = !options.awareness;
    this.awareness = options.awareness ?? new Awareness(options.doc);
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.livenessTimeoutMs = options.livenessTimeoutMs ?? 30_000;

    this.doc.on('update', this.handleDocUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);
    if (options.connect ?? true) this.connect();
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  /** True once the initial state exchange with the server has completed on this connection. */
  get synced(): boolean {
    return this._synced;
  }

  connect(): void {
    this.shouldConnect = true;
    if (!this.socket && !this.reconnectTimer && !this.opening) void this.openSocket();
  }

  disconnect(): void {
    this.shouldConnect = false;
    this.clearReconnectTimer();
    this.socket?.close(CloseCode.Normal, 'client disconnect');
  }

  override destroy(): void {
    this.disconnect();
    this.teardownSocket();
    this.doc.off('update', this.handleDocUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);
    if (this.ownsAwareness) this.awareness.destroy();
    super.destroy();
  }

  private async openSocket(): Promise<void> {
    this.setStatus('connecting');
    let token: string;
    this.opening = true;
    try {
      token = await this.getToken();
    } catch (error) {
      this.emit('connection-error', [{ message: `token request failed: ${String(error)}` }]);
      this.setStatus('disconnected');
      this.scheduleReconnect();
      return;
    } finally {
      this.opening = false;
    }
    if (!this.shouldConnect || this.socket) {
      if (!this.socket) this.setStatus('disconnected');
      return;
    }

    const url = `${this.serverUrl}${roomPath(this.roomId)}?token=${encodeURIComponent(token)}`;
    const socket = new this.WebSocketImpl(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.startLivenessCheck();
      this.setStatus('connected');
      this.send(encodeSyncStep1(this.doc));
      if (this.awareness.getLocalState() !== null) {
        this.send(encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
      }
    };

    socket.onmessage = (event: MessageEvent) => {
      if (this.socket !== socket) return;
      this.lastMessageAt = Date.now();
      if (!(event.data instanceof ArrayBuffer)) return;
      try {
        this.handleFrame(new Uint8Array(event.data));
      } catch (error) {
        this.emit('connection-error', [{ message: `malformed frame: ${String(error)}` }]);
        socket.close(CloseCode.InternalError, 'malformed frame');
      }
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.teardownSocket();
      if (event.code !== CloseCode.Normal && event.code !== CloseCode.GoingAway) {
        this.emit('connection-error', [
          { message: 'connection closed', code: event.code, reason: event.reason },
        ]);
      }
      if (FATAL_CLOSE_CODES.has(event.code)) this.shouldConnect = false;
      this.scheduleReconnect();
    };

    // Errors are always followed by a close event, which drives reconnection.
    socket.onerror = () => undefined;
  }

  private handleFrame(data: Uint8Array): void {
    const { type, decoder } = decodeFrame(data);
    switch (type) {
      case MessageType.Sync: {
        const { syncType, reply } = handleSyncPayload(decoder, this.doc, this);
        if (reply) this.send(reply);
        if (syncType === SyncMessageType.Step2) this.setSynced(true);
        break;
      }
      case MessageType.Awareness:
        handleAwarenessPayload(decoder, this.awareness, this);
        break;
      case MessageType.QueryAwareness:
        this.send(encodeAwarenessUpdate(this.awareness, [...this.awareness.getStates().keys()]));
        break;
      default:
        // Unknown message types are ignored for forward compatibility.
        break;
    }
  }

  private readonly handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== this) this.send(encodeUpdate(update));
  };

  private readonly handleAwarenessUpdate = (change: AwarenessChange, origin: unknown): void => {
    if (origin !== this) this.send(encodeAwarenessUpdate(this.awareness, changedClients(change)));
  };

  private send(frame: Uint8Array): void {
    const socket = this.socket;
    if (socket && socket.readyState === this.WebSocketImpl.OPEN) socket.send(frame);
  }

  private teardownSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    // Peers are only known through the server; once it is gone their presence is stale.
    const remoteClients = [...this.awareness.getStates().keys()].filter(
      (clientId) => clientId !== this.doc.clientID,
    );
    removeAwarenessStates(this.awareness, remoteClients, this);
    this.setSynced(false);
    this.setStatus('disconnected');
  }

  private startLivenessCheck(): void {
    const interval = Math.max(1_000, Math.floor(this.livenessTimeoutMs / 3));
    this.livenessTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > this.livenessTimeoutMs) {
        this.socket?.close(CloseCode.Normal, 'liveness timeout');
        // A half-open socket may never deliver its close event; reconnect without waiting.
        this.teardownSocket();
        this.scheduleReconnect();
      }
    }, interval);
  }

  private scheduleReconnect(): void {
    if (!this.shouldConnect || this.reconnectTimer) return;
    const delay = backoffDelay(this.attempt++, this.backoff);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldConnect && !this.socket) void this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit('status', [status]);
  }

  private setSynced(synced: boolean): void {
    if (this._synced === synced) return;
    this._synced = synced;
    this.emit('synced', [synced]);
  }
}
