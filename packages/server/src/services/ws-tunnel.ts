/**
 * Tunnel for proxying HTTP requests to runners via Socket.IO.
 *
 * Uses Socket.IO's emit + acknowledgement callback for request/response.
 * No more manual requestId tracking, HTTP long-polling, or deduplication.
 */

import type { Server as SocketIOServer } from 'socket.io';

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
    const room = runnerNsp.adapter.rooms.get(`runner:${runnerId}`);

    if (!room || room.size === 0) {
      reject(new Error(`Runner ${runnerId} not connected`));
      return;
    }

    // Get the actual socket for this runner
    const socketId = room.values().next().value;
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
          reject(new Error(`Tunnel to runner ${runnerId} timed out after ${TUNNEL_TIMEOUT_MS}ms`));
        } else {
          resolve(response);
        }
      },
    );
  });
}
