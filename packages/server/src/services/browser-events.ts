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
import {
  BrowserSessionController,
  BrowserSessionPointerKind,
  InteractiveEnvelopeSchema,
} from '@funny/shared/browser-v1/interactive';
import type { Server as SocketIOServer } from 'socket.io';

import { log } from '../lib/logger.js';
import type { BrowserDeliveryClass, BrowserEventSink, BrowserPublication } from './runner-ports.js';
import {
  SocketIoBrowserEventSink,
  threadPresenceRoom,
  threadStreamRoom,
} from './socketio/browser-event-sink.js';
import { browserV1ResourceStore } from './socketio/browser-v1-resource-store.js';
import { pushAgentResult } from './web-push.js';

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
  if (event.type === 'agent:result') {
    void pushAgentResult(userId, event).catch(() => log.warn('Web Push result delivery failed'));
  }
  const terminal = terminalPublication(userId, event);
  if (terminal) {
    browserEvents?.publish(terminal);
    return;
  }
  if (typeof event.type === 'string' && event.type.startsWith('browser-session:')) {
    // Browser-session events travel only as browser.v1; one without a typed
    // mapping is dropped, never sent as a legacy event.
    const browserSession = browserSessionPublication(userId, event);
    if (browserSession) browserEvents?.publish(browserSession);
    else log.warn('Dropping unmapped browser-session event', { type: event.type });
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

type BrowserSessionData = Record<string, unknown>;

interface BrowserSessionDelivery {
  deliveryClass: DeliveryClass;
  delivery: BrowserDeliveryClass;
}

/** How one browser-session event travels: its typed payload plus its delivery class. */
interface BrowserSessionMapping extends BrowserSessionDelivery {
  payload: any;
  priority: number;
  coalescingKey?: string;
}

interface BrowserSessionContext {
  userId: string;
  sessionId: string;
  data: BrowserSessionData;
}

type BrowserSessionMapper = (context: BrowserSessionContext) => BrowserSessionMapping;

const SNAPSHOT_RECOVERABLE: BrowserSessionDelivery = {
  deliveryClass: DeliveryClass.SNAPSHOT_RECOVERABLE,
  delivery: 'snapshot-recoverable',
};

/** Latest-state browser-session messages: a newer one replaces a queued older one. */
const COALESCIBLE: BrowserSessionDelivery = {
  deliveryClass: DeliveryClass.COALESCIBLE,
  delivery: 'coalescible',
};

const VOLATILE: BrowserSessionDelivery = {
  deliveryClass: DeliveryClass.VOLATILE,
  delivery: 'volatile',
};

const POINTER_KINDS: Record<string, BrowserSessionPointerKind> = {
  move: BrowserSessionPointerKind.MOVE,
  click: BrowserSessionPointerKind.CLICK,
  down: BrowserSessionPointerKind.DOWN,
  up: BrowserSessionPointerKind.UP,
};

function viewportOf(value: unknown): { width: number; height: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { width, height } = value as { width?: unknown; height?: unknown };
  if (typeof width !== 'number' || typeof height !== 'number') return undefined;
  return { width: Math.round(width), height: Math.round(height) };
}

function controllerOf(value: unknown): BrowserSessionController {
  if (value === 'agent') return BrowserSessionController.AGENT;
  if (value === 'user') return BrowserSessionController.USER;
  return BrowserSessionController.UNSPECIFIED;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** A snapshot-recoverable mapping at priority 0, unless `overrides` says otherwise. */
function sessionMapping(
  payload: unknown,
  overrides: Partial<Omit<BrowserSessionMapping, 'payload'>> = {},
): BrowserSessionMapping {
  return { ...SNAPSHOT_RECOVERABLE, priority: 0, ...overrides, payload };
}

/** A latest-state mapping coalesced per session under `browser-<name>:<sessionId>`. */
function coalescedMapping(name: string, sessionId: string, payload: unknown) {
  return sessionMapping(payload, { ...COALESCIBLE, coalescingKey: `browser-${name}:${sessionId}` });
}

function frameMapping({ userId, sessionId, data }: BrowserSessionContext): BrowserSessionMapping {
  const coalescingKey = `browser-frame:${sessionId}`;
  const encoded = typeof data.data === 'string' ? data.data.replace(/^data:[^,]+,/, '') : '';
  const resource = browserV1ResourceStore.put(userId, Buffer.from(encoded, 'base64'), 'image/jpeg');
  if (!resource) {
    const status = create(StatusSchema, {
      code: StatusCode.RESOURCE_EXHAUSTED,
      message: 'Browser frame exceeds the authorized resource budget',
      retryable: true,
    });
    return sessionMapping({ case: 'status', value: status }, { priority: 100, coalescingKey });
  }
  const sequence = (browserSessionSequences.get(sessionId) ?? 0n) + 1n;
  browserSessionSequences.set(sessionId, sequence);
  const frame = create(LargeResourceReferenceSchema, {
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
  });
  return sessionMapping(
    { case: 'frame', value: { sequence, frame } },
    { ...COALESCIBLE, coalescingKey },
  );
}

function dialogValue(dialog: BrowserSessionData | null | undefined) {
  if (!dialog) return undefined;
  return {
    type: String(dialog.type ?? ''),
    message: String(dialog.message ?? ''),
    defaultValue: stringOrUndefined(dialog.defaultValue),
  };
}

function consoleValue(data: BrowserSessionData) {
  return {
    level: String(data.level ?? ''),
    text: String(data.text ?? ''),
    url: stringOrUndefined(data.url),
    line: numberOrUndefined(data.line),
    column: numberOrUndefined(data.column),
    occurredAtMs: BigInt(typeof data.timestamp === 'number' ? Math.floor(data.timestamp) : 0),
  };
}

/** Every browser-session event type with a typed browser.v1 mapping. */
const BROWSER_SESSION_MAPPERS = new Map<string, BrowserSessionMapper>([
  ['browser-session:frame', frameMapping],
  [
    'browser-session:ready',
    ({ data }) =>
      sessionMapping({
        case: 'ready',
        value: {
          targetUrl: String(data.url ?? ''),
          viewport: viewportOf(data.viewport),
          controller: controllerOf(data.controller),
          audioMuted: data.audioMuted !== false,
        },
      }),
  ],
  [
    'browser-session:viewport',
    ({ sessionId, data }) =>
      coalescedMapping('viewport', sessionId, {
        case: 'viewport',
        value: viewportOf(data) ?? { width: 0, height: 0 },
      }),
  ],
  [
    'browser-session:navigated',
    ({ sessionId, data }) =>
      coalescedMapping('navigated', sessionId, {
        case: 'navigated',
        value: { url: String(data.url ?? '') },
      }),
  ],
  [
    'browser-session:controller',
    ({ sessionId, data }) =>
      coalescedMapping('controller', sessionId, {
        case: 'controller',
        value: { controller: controllerOf(data.controller) },
      }),
  ],
  [
    'browser-session:dialog',
    ({ data }) =>
      sessionMapping({
        case: 'dialog',
        value: { dialog: dialogValue(data.dialog as BrowserSessionData | null | undefined) },
      }),
  ],
  [
    'browser-session:agent-opened',
    ({ data }) =>
      sessionMapping({
        case: 'agentOpened',
        value: { threadId: String(data.threadId ?? ''), url: String(data.url ?? '') },
      }),
  ],
  [
    'browser-session:audio',
    ({ sessionId, data }) =>
      coalescedMapping('audio', sessionId, {
        case: 'audio',
        value: { muted: data.muted !== false },
      }),
  ],
  [
    'browser-session:pointer',
    ({ data }) =>
      sessionMapping(
        {
          case: 'pointer',
          value: {
            x: Math.round(Number(data.x) || 0),
            y: Math.round(Number(data.y) || 0),
            kind: POINTER_KINDS[String(data.kind)] ?? BrowserSessionPointerKind.UNSPECIFIED,
          },
        },
        VOLATILE,
      ),
  ],
  [
    'browser-session:result',
    ({ data }) =>
      sessionMapping({
        case: 'result',
        value: { value: jsonObject({ ok: data.ok, value: data.value, error: data.error }) },
      }),
  ],
  [
    'browser-session:console',
    ({ data }) => sessionMapping({ case: 'console', value: consoleValue(data) }, VOLATILE),
  ],
  [
    'browser-session:error',
    ({ data }) =>
      sessionMapping(
        {
          case: 'status',
          value: create(StatusSchema, {
            code: StatusCode.INTERNAL,
            message: typeof data.message === 'string' ? data.message : 'Browser session failed',
          }),
        },
        { priority: 100 },
      ),
  ],
  [
    'browser-session:closed',
    ({ data }) =>
      sessionMapping(
        { case: 'close', value: { reason: String(data.reason ?? 'closed') } },
        { priority: 100 },
      ),
  ],
]);

function eventData(event: Record<string, unknown>): BrowserSessionData {
  return event.data && typeof event.data === 'object' ? (event.data as BrowserSessionData) : {};
}

function browserSessionPublication(
  userId: string,
  event: Record<string, unknown>,
): BrowserPublication | null {
  const type = typeof event.type === 'string' ? event.type : '';
  const mapper = BROWSER_SESSION_MAPPERS.get(type);
  if (!mapper) return null;
  const data = eventData(event);
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
  if (!sessionId) return null;
  const { payload, deliveryClass, delivery, priority, coalescingKey } = mapper({
    userId,
    sessionId,
    data,
  });
  const requestId = stringOrUndefined(data.requestId);
  return {
    scope: { kind: 'user', userId },
    logicalType: type,
    trafficClass: 'browserSession',
    delivery: { class: delivery, priority, coalescingKey },
    // Evaluation results can contain nested bigint values. Both representations
    // must normalize them before reaching their JSON encoders.
    legacyEvent: type === 'browser-session:result' ? jsonObject(event) : event,
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
    // Socket.IO's legacy JSON encoder cannot serialize the gRPC uint64 bigint.
    // Keep the exact sequence in protobuf and use a decimal string for JSON.
    legacyEvent:
      typeof data.sequence === 'bigint'
        ? { ...event, data: { ...data, sequence: data.sequence.toString() } }
        : event,
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
