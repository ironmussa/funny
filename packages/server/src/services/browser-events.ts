/**
 * Browser event publication facade for the central server.
 * Routes application events to browser clients through the configured sink.
 *
 * Browser delivery uses Socket.IO rooms. Runner presence is derived only from
 * authenticated runner.v2 gRPC control sessions.
 */

import type { Server as SocketIOServer } from 'socket.io';

import type { BrowserEventSink } from './runner-ports.js';
import {
  SocketIoBrowserEventSink,
  threadPresenceRoom,
  threadStreamRoom,
} from './socketio/browser-event-sink.js';

export { threadPresenceRoom, threadStreamRoom };

// ── Socket.IO reference ─────────────────────────────────
// Set by socketio.ts after initialization to avoid circular imports

let browserEvents: BrowserEventSink | null = null;
let socketIoBrowserEvents: SocketIoBrowserEventSink | null = null;

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
  browserEvents?.toUser(userId, event);
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
