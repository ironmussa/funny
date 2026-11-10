/**
 * Runner side of the gRPC WebSocket carrier (`RUNNER_GRPC_WS_PATH`).
 *
 * grpc-js only dials TCP, so the runner listens on an ephemeral loopback port
 * and pipes each accepted connection into its own WebSocket to the server's
 * public origin. The gRPC client connects to that loopback address; TLS and
 * authentication of the outer hop come from the HTTPS/WSS origin, and the
 * runner bearer token still authenticates every gRPC stream end-to-end.
 */

import { ByteWriteQueue, frameBytes, type ByteWebSocket } from '@funny/shared/lib/byte-write-queue';
import { RUNNER_GRPC_WS_MAX_BUFFERED_BYTES } from '@funny/shared/runner-protocol';

import { log } from '../lib/logger.js';

export interface GrpcWebSocketBridge {
  /** `127.0.0.1:<port>` for the gRPC client. */
  address: string;
  close(): void;
}

/** Minimal client WebSocket surface (WHATWG `WebSocket`). */
export type BridgeWebSocket = ByteWebSocket;

export interface GrpcWebSocketBridgeOptions {
  /**
   * The runner's bearer token, sent as `Authorization` on every WebSocket
   * upgrade so the server can authenticate the carrier before it opens a pipe
   * to its gRPC listener (gRPC still authenticates every stream end-to-end).
   */
  bearerToken?: string;
  maxBufferedBytes?: number;
  createWebSocket?: (url: string) => BridgeWebSocket;
}

interface BridgeSocket {
  write(chunk: Uint8Array): number;
  end(): void;
  data: BridgeConnection;
}

interface BridgeConnection {
  ws: BridgeWebSocket;
  toWebSocket: Uint8Array[];
  toSocket: ByteWriteQueue;
  closed: boolean;
}

const WS_OPEN = 1;

/** Bun's WebSocket client accepts upgrade headers, which the DOM typings omit. */
type BunWebSocketConstructor = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => BridgeWebSocket;
const BunWebSocket = WebSocket as unknown as BunWebSocketConstructor;

export function isWebSocketEndpoint(endpoint: string): boolean {
  return /^wss?:\/\//i.test(endpoint.trim());
}

export function startGrpcWebSocketBridge(
  url: string,
  options: GrpcWebSocketBridgeOptions = {},
): GrpcWebSocketBridge {
  const maxBuffered = options.maxBufferedBytes ?? RUNNER_GRPC_WS_MAX_BUFFERED_BYTES;
  const headers = options.bearerToken
    ? { authorization: `Bearer ${options.bearerToken}` }
    : undefined;
  const createWebSocket =
    options.createWebSocket ?? ((target: string) => new BunWebSocket(target, { headers }));
  const connections = new Set<BridgeConnection>();

  const shut = (socket: BridgeSocket, reason: string) => {
    const conn = socket.data;
    if (conn.closed) return;
    conn.closed = true;
    connections.delete(conn);
    conn.toWebSocket.length = 0;
    conn.toSocket.clear();
    socket.end();
    if (conn.ws.readyState <= WS_OPEN) conn.ws.close(1000, reason);
  };

  const listener = Bun.listen<BridgeConnection>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        const ws = createWebSocket(url);
        ws.binaryType = 'arraybuffer';
        const conn: BridgeConnection = {
          ws,
          toWebSocket: [],
          toSocket: new ByteWriteQueue(maxBuffered),
          closed: false,
        };
        socket.data = conn;
        connections.add(conn);
        ws.onopen = () => {
          for (const chunk of conn.toWebSocket) ws.send(chunk);
          conn.toWebSocket.length = 0;
        };
        ws.onmessage = (event) => {
          if (conn.closed) return;
          const bytes = frameBytes(event.data);
          if (!bytes) return shut(socket as BridgeSocket, 'unexpected text frame');
          if (!conn.toSocket.push(bytes))
            return shut(socket as BridgeSocket, 'grpc client too slow');
          if (!conn.toSocket.flush(socket)) shut(socket as BridgeSocket, 'grpc client closed');
        };
        ws.onerror = () => {
          log.warn('Runner gRPC WebSocket carrier error', { namespace: 'runner' });
        };
        ws.onclose = () => shut(socket as BridgeSocket, 'carrier closed');
      },
      data(socket, chunk) {
        const conn = socket.data;
        if (conn.closed) return;
        if (conn.ws.readyState === WS_OPEN) {
          conn.ws.send(chunk.slice());
          if (conn.ws.bufferedAmount > maxBuffered) shut(socket, 'carrier too slow');
          return;
        }
        const pending = conn.toWebSocket.reduce((sum, c) => sum + c.byteLength, 0);
        if (pending + chunk.byteLength > maxBuffered) return shut(socket, 'carrier not open');
        conn.toWebSocket.push(chunk.slice());
      },
      drain(socket) {
        const conn = socket.data;
        if (!conn.closed && !conn.toSocket.flush(socket)) shut(socket, 'grpc client closed');
      },
      close(socket) {
        shut(socket, 'grpc client closed');
      },
      error(socket, error) {
        log.warn('Runner gRPC carrier loopback socket error', {
          namespace: 'runner',
          error: error.message,
        });
        shut(socket, 'grpc client error');
      },
    },
  });

  return {
    address: `127.0.0.1:${listener.port}`,
    close() {
      listener.stop(true);
      for (const conn of connections) {
        conn.closed = true;
        if (conn.ws.readyState <= WS_OPEN) conn.ws.close(1000, 'runner transport closed');
      }
      connections.clear();
    },
  };
}
