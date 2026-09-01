/**
 * Browser event publication facade for the central server.
 * Routes application events to browser clients through the configured sink.
 *
 * Browser delivery uses Socket.IO rooms. Runner presence is derived only from
 * authenticated runner.v2 gRPC control sessions.
 */

import { create, type JsonObject, type JsonValue } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  DeliveryClass,
  DeliveryMetadataSchema,
  LargeResourceReferenceSchema,
  RequestMetadataSchema,
  ResourceKind,
  ResourceReferenceSchema,
  StatusCode,
  StatusSchema,
} from '@funny/shared/browser-v1/common';
import { InteractiveEnvelopeSchema } from '@funny/shared/browser-v1/interactive';
import type { Server as SocketIOServer } from 'socket.io';

import type { BrowserEventSink } from './runner-ports.js';
import {
  SocketIoBrowserEventSink,
  threadPresenceRoom,
  threadStreamRoom,
} from './socketio/browser-event-sink.js';
import { browserV1ResourceStore } from './socketio/browser-v1-resource-store.js';

export { threadPresenceRoom, threadStreamRoom };

// ── Socket.IO reference ─────────────────────────────────
// Set by socketio.ts after initialization to avoid circular imports

let browserEvents: BrowserEventSink | null = null;
let socketIoBrowserEvents: SocketIoBrowserEventSink | null = null;
const browserSessionSequences = new Map<string, bigint>();

export function setIO(io: SocketIOServer): void {
  socketIoBrowserEvents = io ? new SocketIoBrowserEventSink(io) : null;
  browserEvents = socketIoBrowserEvents;
}

export function setBrowserEventSink(sink: BrowserEventSink | null): void {
  browserEvents = sink;
  socketIoBrowserEvents = sink instanceof SocketIoBrowserEventSink ? sink : null;
}

// ── Event relay ─────────────────────────────────────────

/**
 * Relay an event from a runner to all browser clients of a specific user.
 * Uses Socket.IO rooms for delivery.
 */
export function relayToUser(userId: string, event: Record<string, unknown>): void {
  const terminal = terminalPublication(userId, event);
  if (terminal) {
    browserEvents?.publish(terminal);
    return;
  }
  const browserSession = browserSessionPublication(userId, event);
  if (browserSession) {
    browserEvents?.publish(browserSession);
    return;
  }
  browserEvents?.toUser(userId, event);
}

function jsonObject(value: unknown): JsonObject {
  const normalized = jsonValue(value, new WeakSet<object>());
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized
    : { value: normalized };
}

function jsonValue(value: unknown, seen: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => jsonValue(entry, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, jsonValue(entry, seen)]),
  );
}

function browserSessionPublication(
  userId: string,
  event: Record<string, unknown>,
): import('./runner-ports.js').BrowserPublication | null {
  const type = typeof event.type === 'string' ? event.type : '';
  if (!type.startsWith('browser-session:')) return null;
  const data =
    event.data && typeof event.data === 'object'
      ? (event.data as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
  if (!sessionId) return null;
  let deliveryClass = DeliveryClass.SNAPSHOT_RECOVERABLE;
  let delivery: import('./runner-ports.js').BrowserDeliveryClass = 'snapshot-recoverable';
  let priority = 0;
  let coalescingKey: string | undefined;
  let payload: any;
  if (type === 'browser-session:frame') {
    deliveryClass = DeliveryClass.COALESCIBLE;
    delivery = 'coalescible';
    coalescingKey = `browser-frame:${sessionId}`;
    const encoded = typeof data.data === 'string' ? data.data.replace(/^data:[^,]+,/, '') : '';
    const resource = browserV1ResourceStore.put(
      userId,
      Buffer.from(encoded, 'base64'),
      'image/jpeg',
    );
    if (!resource) {
      payload = {
        case: 'status',
        value: create(StatusSchema, {
          code: StatusCode.RESOURCE_EXHAUSTED,
          message: 'Browser frame exceeds the authorized resource budget',
          retryable: true,
        }),
      };
      deliveryClass = DeliveryClass.SNAPSHOT_RECOVERABLE;
      delivery = 'snapshot-recoverable';
      priority = 100;
    } else {
      const sequence = (browserSessionSequences.get(sessionId) ?? 0n) + 1n;
      browserSessionSequences.set(sessionId, sequence);
      payload = {
        case: 'frame',
        value: {
          sequence,
          frame: create(LargeResourceReferenceSchema, {
            resource: create(ResourceReferenceSchema, {
              kind: ResourceKind.HTTP_OBJECT,
              id: resource.id,
              parentId: sessionId,
            }),
            authorizedUrl: `/api/browser-v1/resources/${resource.id}`,
            mediaType: resource.mediaType,
            byteLength: BigInt(resource.bytes.byteLength),
            expiresAt: timestampFromDate(resource.expiresAt),
            entityTag: resource.entityTag,
          }),
        },
      };
    }
  } else if (type === 'browser-session:ready') {
    payload = { case: 'ready', value: { targetUrl: String(data.url ?? '') } };
  } else if (type === 'browser-session:result') {
    payload = {
      case: 'result',
      value: { value: jsonObject({ ok: data.ok, value: data.value, error: data.error }) },
    };
  } else if (type === 'browser-session:console') {
    deliveryClass = DeliveryClass.VOLATILE;
    delivery = 'volatile';
    payload = {
      case: 'console',
      value: {
        level: String(data.level ?? ''),
        text: String(data.text ?? ''),
        url: typeof data.url === 'string' ? data.url : undefined,
        line: typeof data.line === 'number' ? data.line : undefined,
        column: typeof data.column === 'number' ? data.column : undefined,
        occurredAtMs: BigInt(typeof data.timestamp === 'number' ? Math.floor(data.timestamp) : 0),
      },
    };
  } else if (type === 'browser-session:error') {
    priority = 100;
    payload = {
      case: 'status',
      value: create(StatusSchema, {
        code: StatusCode.INTERNAL,
        message: typeof data.message === 'string' ? data.message : 'Browser session failed',
      }),
    };
  } else if (type === 'browser-session:closed') {
    priority = 100;
    payload = { case: 'close', value: { reason: String(data.reason ?? 'closed') } };
  } else {
    return null;
  }
  const requestId = typeof data.requestId === 'string' ? data.requestId : undefined;
  return {
    scope: { kind: 'user', userId },
    logicalType: type,
    trafficClass: 'browserSession',
    delivery: { class: delivery, priority, coalescingKey },
    legacyEvent: event,
    browserV1Interactive: create(InteractiveEnvelopeSchema, {
      metadata: requestId ? create(RequestMetadataSchema, { requestId }) : undefined,
      delivery: create(DeliveryMetadataSchema, { deliveryClass, priority, coalescingKey }),
      payload: { case: 'browserSession', value: { browserSessionId: sessionId, payload } },
    }),
  };
}

function terminalPublication(
  userId: string,
  event: Record<string, unknown>,
): import('./runner-ports.js').BrowserPublication | null {
  const type = typeof event.type === 'string' ? event.type : '';
  if (type !== 'pty:data' && type !== 'pty:exit' && type !== 'pty:error') return null;
  const data =
    event.data && typeof event.data === 'object'
      ? (event.data as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const terminalId = typeof data.ptyId === 'string' ? data.ptyId : '';
  if (!terminalId) return null;
  const payload =
    type === 'pty:data'
      ? {
          case: 'output' as const,
          value: {
            sequence:
              typeof data.sequence === 'bigint'
                ? data.sequence
                : BigInt(typeof data.sequence === 'number' ? data.sequence : 0),
            data:
              data.data instanceof Uint8Array
                ? data.data
                : new TextEncoder().encode(typeof data.data === 'string' ? data.data : ''),
          },
        }
      : type === 'pty:exit'
        ? {
            case: 'exit' as const,
            value: {
              exitCode: typeof data.exitCode === 'number' ? data.exitCode : undefined,
            },
          }
        : {
            case: 'error' as const,
            value: {
              status: create(StatusSchema, {
                code: StatusCode.INTERNAL,
                message: typeof data.error === 'string' ? data.error : 'Terminal failed',
              }),
            },
          };
  return {
    scope: { kind: 'user', userId },
    logicalType: type,
    trafficClass: 'terminal',
    delivery: { class: 'durable', priority: type === 'pty:data' ? 0 : 100 },
    legacyEvent: event,
    browserV1Interactive: create(InteractiveEnvelopeSchema, {
      delivery: create(DeliveryMetadataSchema, { deliveryClass: DeliveryClass.DURABLE }),
      payload: { case: 'terminal', value: { terminalId, payload } },
    }),
  };
}

/**
 * Relay an event to all browser clients (broadcast).
 */
export function broadcast(event: Record<string, unknown>): void {
  browserEvents?.toAll(event);
}

// ── Per-thread rooms (thread-sharing) ───────────────────
//
// Two rooms per shared thread, deliberately separate so the owner never
// double-receives the agent stream:
//   thread:<id>:stream   — joined ONLY by sharees. The agent stream is mirrored
//                          here IN ADDITION to the owner's `user:` room. The
//                          owner is NOT in this room (they get the stream via
//                          `user:`), so no duplicate delivery — important
//                          because some events (e.g. agent:tool_output) append
//                          rather than upsert on the client.
//   thread:<id>:presence — joined by ALL current viewers (owner + sharees) so
//                          everyone sees everyone's avatar. Carries only
//                          presence (awareness) events, never the agent stream.

/** Mirror an in-thread agent event to the sharee-only stream room. */
export function relayToThreadStream(threadId: string, event: Record<string, unknown>): void {
  browserEvents?.toThreadStream(threadId, event);
}

/** Broadcast a presence event to every viewer of a thread. */
export function relayToThreadPresence(threadId: string, event: Record<string, unknown>): void {
  browserEvents?.toThreadPresence(threadId, event);
}

/**
 * Broadcast a non-stream, all-viewers event (e.g. a new/deleted comment) to
 * every current viewer of a thread. Targets the presence room because that is
 * exactly the "all current viewers" audience (owner + sharees) with single
 * delivery — unlike the stream room, the owner IS in the presence room, so this
 * reaches them too without the double-delivery the stream room avoids.
 */
export function relayToThreadViewers(threadId: string, event: Record<string, unknown>): void {
  browserEvents?.toThreadViewers(threadId, event);
}

/**
 * Evict a user from a thread's rooms (on share revoke). Makes every one of the
 * user's browser sockets leave the stream + presence rooms, so they stop
 * receiving live data immediately even before their next HTTP request 404s.
 */
export function evictUserFromThread(userId: string, threadId: string): void {
  browserEvents?.evictFromThread(userId, threadId);
}

/**
 * Get all connected browser user IDs.
 * Uses Socket.IO rooms to find user rooms.
 */
export function getConnectedBrowserUserIds(): string[] {
  return socketIoBrowserEvents?.connectedUserIds() ?? [];
}

/**
 * Get stats about connected clients.
 */
export function getRelayStats(): {
  browserClients: number;
  browserUsers: number;
} {
  const { browserClients, browserUsers } = socketIoBrowserEvents?.stats() ?? {
    browserClients: 0,
    browserUsers: 0,
  };
  return { browserClients, browserUsers };
}
