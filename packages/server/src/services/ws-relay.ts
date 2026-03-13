/**
 * WebSocket relay for the central server.
 * Routes events between runners and browser clients.
 *
 * - Browser clients connect via /ws (session cookie auth)
 * - Runners connect via /ws/runner (bearer token auth)
 * - When a runner sends agent events, they're relayed to the appropriate browser
 * - When a browser needs to start/stop an agent, a task is created for the runner
 */

import { log } from '../lib/logger.js';

type WebSocketLike = {
  send(data: string): void;
  close(): void;
};

// ── Connection tracking ─────────────────────────────────

/** userId → Set of browser WebSockets */
const browserClients = new Map<string, Set<WebSocketLike>>();

/** runnerId → WebSocket */
const runnerClients = new Map<string, WebSocketLike>();

// ── Browser client management ───────────────────────────

export function addBrowserClient(userId: string, ws: WebSocketLike): void {
  let clients = browserClients.get(userId);
  if (!clients) {
    clients = new Set();
    browserClients.set(userId, clients);
  }
  clients.add(ws);
  log.info('Browser client connected', { namespace: 'ws-relay', userId });
}

export function removeBrowserClient(userId: string, ws: WebSocketLike): void {
  const clients = browserClients.get(userId);
  if (clients) {
    clients.delete(ws);
    if (clients.size === 0) browserClients.delete(userId);
  }
}

// ── Runner client management ────────────────────────────

export function addRunnerClient(runnerId: string, ws: WebSocketLike): void {
  runnerClients.set(runnerId, ws);
  log.info('Runner connected', { namespace: 'ws-relay', runnerId });
}

export function removeRunnerClient(runnerId: string): void {
  runnerClients.delete(runnerId);
  log.info('Runner disconnected', { namespace: 'ws-relay', runnerId });
}

// ── Event relay ─────────────────────────────────────────

/**
 * Relay an event from a runner to all browser clients of a specific user.
 */
export function relayToUser(userId: string, event: Record<string, unknown>): void {
  const clients = browserClients.get(userId);
  if (!clients || clients.size === 0) return;

  const data = JSON.stringify(event);
  for (const ws of clients) {
    try {
      ws.send(data);
    } catch {
      // Client disconnected
    }
  }
}

/**
 * Relay an event to all browser clients (broadcast).
 */
export function broadcast(event: Record<string, unknown>): void {
  const data = JSON.stringify(event);
  for (const [, clients] of browserClients) {
    for (const ws of clients) {
      try {
        ws.send(data);
      } catch {}
    }
  }
}

/**
 * Send a command to a specific runner.
 */
export function sendToRunner(runnerId: string, command: Record<string, unknown>): boolean {
  const ws = runnerClients.get(runnerId);
  if (!ws) return false;

  try {
    ws.send(JSON.stringify(command));
    return true;
  } catch {
    return false;
  }
}

/**
 * Forward a browser WS message to a runner for local handling.
 * Used for PTY commands (pty:spawn, pty:write, etc.) and other
 * browser → runner real-time messages.
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
  const first = runnerClients.keys().next();
  return first.done ? null : first.value;
}

/**
 * Get stats about connected clients.
 */
export function getRelayStats(): {
  browserClients: number;
  browserUsers: number;
  runners: number;
} {
  let totalBrowserClients = 0;
  for (const [, clients] of browserClients) {
    totalBrowserClients += clients.size;
  }
  return {
    browserClients: totalBrowserClients,
    browserUsers: browserClients.size,
    runners: runnerClients.size,
  };
}
