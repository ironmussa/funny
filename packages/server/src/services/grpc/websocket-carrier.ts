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
 * Nothing here parses gRPC: the `runner.v2` protocol, its limits and its
 * per-stream authentication stay in the gRPC endpoint.
 *
 * The carrier does authenticate the upgrade itself, so unauthenticated
 * sockets cannot hold its slots: a runner sends its bearer token as
 * `Authorization` and the carrier verifies it (`authenticate`) before opening a
 * pipe; a bad token is refused. Runners from before this check send no token;
 * while `unauthenticated` is allowed they get a separate small pool (total and
 * per address) and must send their first bytes within `firstByteMs`, so they
 * can never crowd out authenticated runners.
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
  sawData: boolean;
  firstByteTimer?: ReturnType<typeof setTimeout>;
}

export interface CarrierWebSocketData {
  kind: typeof RUNNER_GRPC_WS_KIND;
  /** True when the upgrade carried a valid runner token. */
  authenticated: boolean;
  /** Caller address, for the per-address cap on unauthenticated sockets. */
  address: string;
  state?: CarrierState;
}

export interface UnauthenticatedCarrierPolicy {
  /** Unauthenticated sockets open at once, across all callers. */
  maxConnections: number;
  /** Unauthenticated sockets open at once from one address. */
  maxPerAddress: number;
  /** Close an unauthenticated socket that sends nothing for this long after opening. */
  firstByteMs: number;
}

export const DEFAULT_UNAUTHENTICATED_CARRIER_POLICY: UnauthenticatedCarrierPolicy = {
  maxConnections: 64,
  maxPerAddress: 4,
  firstByteMs: 10_000,
};

export interface RunnerGrpcWebSocketCarrierOptions {
  /** Where the gRPC listener accepts connections from this process. */
  target: { hostname: string; port: number };
  maxConnections?: number;
  maxBufferedBytes?: number;
  connect?: CarrierTcpConnect;
  /** Runner id for a bearer token, or null when the token is not valid. */
  authenticate: (token: string) => Promise<string | null>;
  /** Tokenless upgrades from older runners; `false` refuses them. */
  unauthenticated?: UnauthenticatedCarrierPolicy | false;
}

/** `RUNNER_GRPC_WS_ALLOW_UNAUTHENTICATED=false` refuses tokenless carrier upgrades. */
export function unauthenticatedCarrierPolicyFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): UnauthenticatedCarrierPolicy | false {
  return env.RUNNER_GRPC_WS_ALLOW_UNAUTHENTICATED === 'false'
    ? false
    : DEFAULT_UNAUTHENTICATED_CARRIER_POLICY;
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
  const unauthenticatedPolicy =
    options.unauthenticated === undefined
      ? DEFAULT_UNAUTHENTICATED_CARRIER_POLICY
      : options.unauthenticated;
  const active = new Set<CarrierWebSocket>();
  /** Unauthenticated sockets reserved or open, total and per address. */
  let unauthenticatedCount = 0;
  const unauthenticatedByAddress = new Map<string, number>();

  const releaseUnauthenticatedSlot = (address: string) => {
    unauthenticatedCount -= 1;
    const left = (unauthenticatedByAddress.get(address) ?? 1) - 1;
    if (left > 0) unauthenticatedByAddress.set(address, left);
    else unauthenticatedByAddress.delete(address);
  };

  const refuse = (status: number, reason: string, body: string) => {
    metric('runner_grpc.ws_carrier.rejected', 1, { attributes: { reason } });
    return new Response(body, { status });
  };

  /** Idempotent: releases the listener socket and counts the close once. */
  const release = (ws: CarrierWebSocket, reason: string) => {
    const state = ws.data.state;
    if (state && !state.closed) {
      state.closed = true;
      if (state.firstByteTimer) clearTimeout(state.firstByteTimer);
      state.toListener.clear();
      state.socket?.end();
    }
    if (active.delete(ws)) {
      if (!ws.data.authenticated) releaseUnauthenticatedSlot(ws.data.address);
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

    /** Upgrades the request. Resolves to a Response only when the upgrade is refused. */
    async upgrade(
      req: Request,
      server: { upgrade(req: Request, opts: { data: CarrierWebSocketData }): boolean },
      address: string,
    ): Promise<Response | undefined> {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('WebSocket upgrade required', { status: 426 });
      }
      const authorization = req.headers.get('authorization');
      const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

      if (token) {
        let runnerId: string | null = null;
        try {
          runnerId = await options.authenticate(token);
        } catch (error) {
          log.warn('Runner gRPC carrier could not authenticate an upgrade', {
            namespace: 'runner-grpc',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!runnerId) return refuse(401, 'unauthenticated', 'Invalid runner token');
        if (active.size >= maxConnections) {
          return refuse(503, 'capacity', 'Runner carrier at capacity');
        }
        const data: CarrierWebSocketData = {
          kind: RUNNER_GRPC_WS_KIND,
          authenticated: true,
          address,
        };
        if (server.upgrade(req, { data })) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      // A runner from before the carrier checked tokens.
      if (!unauthenticatedPolicy) {
        return refuse(401, 'token-required', 'Runner token required');
      }
      if (
        unauthenticatedCount >= unauthenticatedPolicy.maxConnections ||
        active.size >= maxConnections
      ) {
        return refuse(503, 'unauthenticated-capacity', 'Runner carrier at capacity');
      }
      const fromAddress = unauthenticatedByAddress.get(address) ?? 0;
      if (fromAddress >= unauthenticatedPolicy.maxPerAddress) {
        return refuse(429, 'unauthenticated-per-address', 'Too many runner connections');
      }
      // Reserve the slot now; `release` (or a failed upgrade) gives it back.
      unauthenticatedCount += 1;
      unauthenticatedByAddress.set(address, fromAddress + 1);
      const data: CarrierWebSocketData = {
        kind: RUNNER_GRPC_WS_KIND,
        authenticated: false,
        address,
      };
      if (server.upgrade(req, { data })) return undefined;
      releaseUnauthenticatedSlot(address);
      return new Response('WebSocket upgrade failed', { status: 400 });
    },

    websocket: {
      open(ws: CarrierWebSocket) {
        const state: CarrierState = {
          socket: null,
          toListener: new ByteWriteQueue(maxBuffered),
          closed: false,
          sawData: false,
        };
        ws.data.state = state;
        active.add(ws);
        metric('runner_grpc.ws_carrier.opened', 1, {
          attributes: { authenticated: String(ws.data.authenticated) },
        });
        if (!ws.data.authenticated && unauthenticatedPolicy) {
          state.firstByteTimer = setTimeout(() => {
            if (!state.closed && !state.sawData) shut(ws, 1008, 'no data');
          }, unauthenticatedPolicy.firstByteMs);
          state.firstByteTimer.unref?.();
        }

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
        state.sawData = true;
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

/**
 * Upgrade request for the carrier path; `null` when the path is not the
 * carrier's. `address` is the caller's address (per-address cap on
 * unauthenticated sockets).
 */
export function routeRunnerCarrier(
  req: Request,
  server: unknown,
  carrier: Carrier | null,
  address: string,
): Promise<Response | undefined> | Response | null {
  if (new URL(req.url).pathname !== RUNNER_GRPC_WS_PATH) return null;
  if (!carrier) return new Response('Runner transport disabled', { status: 404 });
  return carrier.upgrade(req, server as Parameters<Carrier['upgrade']>[1], address);
}
