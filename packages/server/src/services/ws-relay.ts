/**
 * WebSocket relay for the central server.
 * Routes events between runners and browser clients.
 *
 * Now backed by Socket.IO rooms instead of manual Maps.
 * The runnerSockets map is kept as a lightweight index for quick lookups
 * (isRunnerConnected, getAnyConnectedRunnerId).
 */

import type { Server as SocketIOServer } from 'socket.io';

import { log } from '../lib/logger.js';

// ── Socket.IO reference ─────────────────────────────────
// Set by socketio.ts after initialization to avoid circular imports

let _io: SocketIOServer | null = null;

export function setIO(io: SocketIOServer): void {
  _io = io;
}

// ── Connection tracking (lightweight index) ──────────────

/** runnerId → socketId (for quick isRunnerConnected check) */
const runnerSockets = new Map<string, string>();

// ── Runner client management ────────────────────────────

export function addRunnerClient(runnerId: string, socketId: string): void {
  runnerSockets.set(runnerId, socketId);
  log.info('Runner connected', { namespace: 'ws-relay', runnerId });
}

export function removeRunnerClient(runnerId: string): void {
  runnerSockets.delete(runnerId);
  log.info('Runner disconnected', { namespace: 'ws-relay', runnerId });
}

/** Check if a runner is connected via Socket.IO. */
export function isRunnerConnected(runnerId: string): boolean {
  return runnerSockets.has(runnerId);
}

// ── Event relay ─────────────────────────────────────────

/**
 * Relay an event from a runner to all browser clients of a specific user.
 * Uses Socket.IO rooms for delivery.
 */
export function relayToUser(userId: string, event: Record<string, unknown>): void {
  if (!_io) return;
  const eventType = (event.type as string) || 'event';
  _io.of('/').to(`user:${userId}`).emit(eventType, event);
}

/**
 * Relay an event to all browser clients (broadcast).
 */
export function broadcast(event: Record<string, unknown>): void {
  if (!_io) return;
  const eventType = (event.type as string) || 'event';
  _io.of('/').emit(eventType, event);
}

/**
 * Send a command to a specific runner via Socket.IO.
 */
export function sendToRunner(runnerId: string, command: Record<string, unknown>): boolean {
  if (!_io) return false;
  const eventType = (command.type as string) || 'command';
  _io.of('/runner').to(`runner:${runnerId}`).emit(eventType, command);
  return true;
}

/**
 * Forward a browser WS message to a runner for local handling.
 * Used for PTY commands and other browser → runner real-time messages.
 */
export function forwardBrowserMessageToRunner(
  runnerId: string,
  userId: string,
  organizationId: string | undefined,
  data: unknown,
): boolean {
  return sendToRunner(runnerId, {
    type: 'central:browser_ws',
    userId,
    organizationId,
    data,
  });
}

/**
 * Get the ID of any connected runner.
 * Used as a fallback when no project/thread context is available.
 */
export function getAnyConnectedRunnerId(): string | null {
  const first = runnerSockets.keys().next();
  return first.done ? null : first.value;
}

/**
 * Get all connected browser user IDs.
 * Uses Socket.IO rooms to find user rooms.
 */
export function getConnectedBrowserUserIds(): string[] {
  if (!_io) return [];
  const rooms = _io.of('/').adapter.rooms;
  const userIds: string[] = [];
  for (const [room] of rooms) {
    if (room.startsWith('user:')) userIds.push(room.slice(5));
  }
  return userIds;
}

/**
 * Get stats about connected clients.
 */
export function getRelayStats(): {
  browserClients: number;
  browserUsers: number;
  runners: number;
} {
  let browserClients = 0;
  let browserUsers = 0;
  if (_io) {
    browserClients = _io.of('/').sockets.size;
    const rooms = _io.of('/').adapter.rooms;
    for (const [room] of rooms) {
      if (room.startsWith('user:')) browserUsers++;
    }
  }
  return {
    browserClients,
    browserUsers,
    runners: runnerSockets.size,
  };
}
