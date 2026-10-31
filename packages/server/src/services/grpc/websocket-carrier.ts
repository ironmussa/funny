/**
 * @domain subdomain: Runner Transport
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * WebSocket carrier for the runner gRPC listener (`RUNNER_GRPC_WS_PATH`).
 *
 * Runners outside the private network open a WebSocket on the public HTTPS
 * origin; each connection is piped byte-for-byte to the local gRPC listener.
 * Nothing here parses gRPC: authentication, limits and the `runner.v2`
 * protocol stay in the gRPC endpoint. This only adds a bounded byte pipe.
 */

import { ByteWriteQueue } from '@funny/shared/lib/byte-write-queue';
import {
  RUNNER_GRPC_WS_MAX_BUFFERED_BYTES,
  RUNNER_GRPC_WS_PATH,
} from '@funny/shared/runner-protocol';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';

const RUNNER_GRPC_WS_KIND = 'runner-grpc-ws';

/** Minimal TCP socket surface (Bun `Socket`) used by the carrier. */
export interface CarrierTcpSocket {
  write(chunk: Uint8Array): number;
  end(): void;
}

export interface CarrierTcpHandlers {
  open(socket: CarrierTcpSocket): void;
  data(socket: CarrierTcpSocket, chunk: Uint8Array): void;
  drain(socket: CarrierTcpSocket): void;
  close(socket: CarrierTcpSocket): void;
  error(socket: CarrierTcpSocket, error: Error): void;
}

export type CarrierTcpConnect = (target: {
  hostname: string;
  port: number;
  handlers: CarrierTcpHandlers;
}) => Promise<unknown>;

/** Minimal server WebSocket surface (Bun `ServerWebSocket`) used by the carrier. */
export interface CarrierWebSocket {
  data: CarrierWebSocketData;
  send(chunk: Uint8Array): number;
  getBufferedAmount(): number;
  close(code?: number, reason?: string): void;
}

interface CarrierState {
  socket: CarrierTcpSocket | null;
  toListener: ByteWriteQueue;
  closed: boolean;
}

export interface CarrierWebSocketData {
  kind: typeof RUNNER_GRPC_WS_KIND;
  state?: CarrierState;
}

export interface RunnerGrpcWebSocketCarrierOptions {
  /** Where the gRPC listener accepts connections from this process. */
  target: { hostname: string; port: number };
  maxConnections?: number;
  maxBufferedBytes?: number;
  connect?: CarrierTcpConnect;
}

const defaultConnect: CarrierTcpConnect = ({ hostname, port, handlers }) =>
  Bun.connect({ hostname, port, socket: handlers });

/** The listener binds wildcard addresses; the carrier always dials loopback. */
export function carrierTargetFor(endpoint: { host: string; port: number }) {
  const wildcard = ['0.0.0.0', '::', '[::]', ''].includes(endpoint.host);
  return {
    hostname: wildcard ? '127.0.0.1' : endpoint.host.replace(/^\[|\]$/g, ''),
    port: endpoint.port,
  };
}

export function createRunnerGrpcWebSocketCarrier(options: RunnerGrpcWebSocketCarrierOptions) {
  const maxConnections = options.maxConnections ?? 512;
  const maxBuffered = options.maxBufferedBytes ?? RUNNER_GRPC_WS_MAX_BUFFERED_BYTES;
  const connect = options.connect ?? defaultConnect;
  const active = new Set<CarrierWebSocket>();

  /** Idempotent: releases the listener socket and counts the close once. */
  const release = (ws: CarrierWebSocket, reason: string) => {
    const state = ws.data.state;
    if (state && !state.closed) {
      state.closed = true;
      state.toListener.clear();
      state.socket?.end();
    }
    if (active.delete(ws)) {
      metric('runner_grpc.ws_carrier.closed', 1, { attributes: { reason } });
    }
  };

  const shut = (ws: CarrierWebSocket, code: number, reason: string) => {
    release(ws, reason);
    ws.close(code, reason);
  };

  return {
    path: RUNNER_GRPC_WS_PATH,

    activeConnections: () => active.size,

    /** Upgrades the request. Returns a Response only when the upgrade is refused. */
    upgrade(
      req: Request,
      server: { upgrade(req: Request, opts: { data: CarrierWebSocketData }): boolean },
    ): Response | undefined {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('WebSocket upgrade required', { status: 426 });
      }
      if (active.size >= maxConnections) {
        metric('runner_grpc.ws_carrier.rejected', 1, { attributes: { reason: 'capacity' } });
        return new Response('Runner carrier at capacity', { status: 503 });
      }
      if (server.upgrade(req, { data: { kind: RUNNER_GRPC_WS_KIND } })) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    },

    websocket: {
      open(ws: CarrierWebSocket) {
        const state: CarrierState = {
          socket: null,
          toListener: new ByteWriteQueue(maxBuffered),
          closed: false,
        };
        ws.data.state = state;
        active.add(ws);
        metric('runner_grpc.ws_carrier.opened', 1);

        connect({
          ...options.target,
          handlers: {
            open(socket) {
              if (state.closed) return socket.end();
              state.socket = socket;
              if (!state.toListener.flush(socket)) shut(ws, 1011, 'listener closed');
            },
            data(_socket, chunk) {
              if (state.closed) return;
              if (ws.send(chunk) === 0) return shut(ws, 1011, 'peer closed');
              if (ws.getBufferedAmount() > maxBuffered) shut(ws, 1013, 'peer too slow');
            },
            drain(socket) {
              if (!state.closed && !state.toListener.flush(socket))
                shut(ws, 1011, 'listener closed');
            },
            close() {
              if (!state.closed) shut(ws, 1000, 'listener closed');
            },
            error(_socket, error) {
              log.warn('Runner gRPC carrier listener socket error', {
                namespace: 'runner-grpc',
                error: error.message,
              });
              if (!state.closed) shut(ws, 1011, 'listener error');
            },
          },
        }).catch((error: unknown) => {
          log.error('Runner gRPC carrier could not reach the gRPC listener', {
            namespace: 'runner-grpc',
            error: error instanceof Error ? error.message : String(error),
          });
          shut(ws, 1011, 'listener unavailable');
        });
      },

      message(ws: CarrierWebSocket, message: string | Uint8Array) {
        const state = ws.data.state;
        if (!state || state.closed) return;
        if (typeof message === 'string') return shut(ws, 1003, 'binary frames only');
        if (!state.toListener.push(message)) return shut(ws, 1013, 'listener too slow');
        if (state.socket && !state.toListener.flush(state.socket)) {
          shut(ws, 1011, 'listener closed');
        }
      },

      close(ws: CarrierWebSocket) {
        release(ws, 'peer');
      },
    },
  };
}

/** True when a Bun server WebSocket belongs to the runner carrier (vs Socket.IO). */
function isCarrierWebSocket(ws: { data?: unknown }): ws is CarrierWebSocket {
  return (ws.data as { kind?: string } | undefined)?.kind === RUNNER_GRPC_WS_KIND;
}

type Carrier = ReturnType<typeof createRunnerGrpcWebSocketCarrier>;

interface EngineWebSocketHandlers {
  open(ws: any): void;
  message(ws: any, message: any): void;
  close(ws: any, code: number, reason: string): void;
}

/**
 * One Bun server hosts Socket.IO sockets and runner carrier sockets; route each
 * WebSocket lifecycle event by the socket's upgrade data.
 */
export function withRunnerCarrier<H extends EngineWebSocketHandlers>(
  engine: H,
  carrier: Carrier | null,
): H {
  return {
    ...engine,
    open: (ws: any) => (isCarrierWebSocket(ws) ? carrier?.websocket.open(ws) : engine.open(ws)),
    message: (ws: any, message: any) =>
      isCarrierWebSocket(ws)
        ? carrier?.websocket.message(ws, message)
        : engine.message(ws, message),
    close: (ws: any, code: number, reason: string) =>
      isCarrierWebSocket(ws) ? carrier?.websocket.close(ws) : engine.close(ws, code, reason),
  };
}

/** Upgrade request for the carrier path; `null` when the path is not the carrier's. */
export function routeRunnerCarrier(
  req: Request,
  server: unknown,
  carrier: Carrier | null,
): Response | undefined | null {
  if (new URL(req.url).pathname !== RUNNER_GRPC_WS_PATH) return null;
  if (!carrier) return new Response('Runner transport disabled', { status: 404 });
  return carrier.upgrade(req, server as Parameters<Carrier['upgrade']>[1]);
}
