import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';

/**
 * Binary wire protocol. Frames are wire-compatible with y-websocket:
 *
 *   varuint messageType | payload
 *
 * where `Sync` carries a y-protocols sync message (step1 / step2 / update) and
 * `Awareness` carries an encoded awareness update. Staying compatible means any stock
 * y-websocket client can talk to this server, which keeps the server honest.
 */
export const MessageType = {
  Sync: 0,
  Awareness: 1,
  QueryAwareness: 3,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const SyncMessageType = {
  Step1: syncProtocol.messageYjsSyncStep1,
  Step2: syncProtocol.messageYjsSyncStep2,
  Update: syncProtocol.messageYjsUpdate,
} as const;
export type SyncMessageType = (typeof SyncMessageType)[keyof typeof SyncMessageType];

function frame(type: MessageType, write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  return frame(MessageType.Sync, (encoder) => syncProtocol.writeSyncStep1(encoder, doc));
}

export function encodeSyncStep2(doc: Y.Doc, remoteStateVector?: Uint8Array): Uint8Array {
  return frame(MessageType.Sync, (encoder) =>
    syncProtocol.writeSyncStep2(encoder, doc, remoteStateVector),
  );
}

export function encodeUpdate(update: Uint8Array): Uint8Array {
  return frame(MessageType.Sync, (encoder) => syncProtocol.writeUpdate(encoder, update));
}

export function encodeAwarenessUpdate(
  awareness: awarenessProtocol.Awareness,
  clientIds: readonly number[],
): Uint8Array {
  return frame(MessageType.Awareness, (encoder) =>
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [...clientIds]),
    ),
  );
}

export function encodeQueryAwareness(): Uint8Array {
  return frame(MessageType.QueryAwareness, () => undefined);
}

export interface DecodedFrame {
  type: number;
  decoder: decoding.Decoder;
}

/** Reads the frame header. Throws on an empty or truncated frame. */
export function decodeFrame(data: Uint8Array): DecodedFrame {
  const decoder = decoding.createDecoder(data);
  const type = decoding.readVarUint(decoder);
  return { type, decoder };
}

export interface SyncHandlingResult {
  syncType: number;
  /** Frame to send back to the peer (a step2 in answer to a step1), if any. */
  reply: Uint8Array | null;
  /** True when the message was dropped because the peer may not write. */
  rejected: boolean;
}

/**
 * Applies the payload of a `Sync` frame to `doc`, tagging resulting transactions with
 * `origin`. Read-only peers may still request state (step1) but their writes are dropped.
 */
export function handleSyncPayload(
  decoder: decoding.Decoder,
  doc: Y.Doc,
  origin: unknown,
  options: { readOnly?: boolean } = {},
): SyncHandlingResult {
  const syncType = decoding.peekVarUint(decoder);
  if (options.readOnly && syncType !== SyncMessageType.Step1) {
    return { syncType, reply: null, rejected: true };
  }
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MessageType.Sync);
  syncProtocol.readSyncMessage(decoder, encoder, doc, origin);
  // The header alone is one byte; anything more means readSyncMessage produced a reply.
  const reply = encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null;
  return { syncType, reply, rejected: false };
}

/** Applies the payload of an `Awareness` frame. */
export function handleAwarenessPayload(
  decoder: decoding.Decoder,
  awareness: awarenessProtocol.Awareness,
  origin: unknown,
): void {
  awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), origin);
}

/** Payload of the awareness `update` event emitted by y-protocols. */
export interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

export function changedClients({ added, updated, removed }: AwarenessChange): number[] {
  return [...added, ...updated, ...removed];
}
