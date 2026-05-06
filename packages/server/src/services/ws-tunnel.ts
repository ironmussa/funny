/**
 * Tunnel for proxying HTTP requests to runners via Socket.IO.
 *
 * Uses Socket.IO's emit + acknowledgement callback for request/response.
 * No more manual requestId tracking, HTTP long-polling, or deduplication.
 */

import type { Server as SocketIOServer } from 'socket.io';

import { getRunnerSocketId } from './ws-relay.js';

// ── Socket.IO reference ─────────────────────────────────
// Set by socketio.ts after initialization to avoid circular imports

let _io: SocketIOServer | null = null;

export function setIO(io: SocketIOServer): void {
  _io = io;
}

const TUNNEL_TIMEOUT_MS = 30_000;

export interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * Raised when the runner did not ack within {@link TUNNEL_TIMEOUT_MS}.
 *
 * Distinct from "runner not connected" because here the request was already
 * delivered — the runner may still be processing it. Callers MUST NOT retry
 * on a different transport (e.g., direct HTTP), or the work duplicates.
 */
export class TunnelTimeoutError extends Error {
  readonly runnerId: string;
  readonly timeoutMs: number;
  constructor(runnerId: string, timeoutMs: number) {
    super(`Tunnel to runner ${runnerId} timed out after ${timeoutMs}ms`);
    this.name = 'TunnelTimeoutError';
    this.runnerId = runnerId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Send an HTTP request to a runner through the Socket.IO tunnel.
 * Returns a Response-like object with status, headers, and body.
 *
 * Uses Socket.IO acknowledgements — the runner responds via the ack callback.
 */
export function tunnelFetch(
  runnerId: string,
  opts: { method: string; path: string; headers: Record<string, string>; body?: string | null },
): Promise<TunnelResponse> {
  return new Promise<TunnelResponse>((resolve, reject) => {
    if (!_io) {
      reject(new Error(`Socket.IO not initialized`));
      return;
    }

    const runnerNsp = _io.of('/runner');
    // Look up the current socket via ws-relay's registry rather than the
    // room — during a reconnect the room may briefly contain both the old
    // and new sockets; the registry always points at exactly one.
    const socketId = getRunnerSocketId(runnerId);
    if (!socketId) {
      reject(new Error(`Runner ${runnerId} not connected`));
      return;
    }
    const socket = runnerNsp.sockets.get(socketId);

    if (!socket) {
      reject(new Error(`Runner ${runnerId} socket not found`));
      return;
    }

    // Emit with timeout + ack — Socket.IO handles the round-trip
    socket.timeout(TUNNEL_TIMEOUT_MS).emit(
      'tunnel:request',
      {
        method: opts.method,
        path: opts.path,
        headers: opts.headers,
        body: opts.body ?? null,
      },
      (err: Error | null, response: TunnelResponse) => {
        if (err) {
          reject(new TunnelTimeoutError(runnerId, TUNNEL_TIMEOUT_MS));
        } else {
          resolve(response);
        }
      },
    );
  });
}
