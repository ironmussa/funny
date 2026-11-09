/**
 * Sandbox end of the reverse runner link (`@funny/shared/reverse-link`).
 *
 * The server cannot be reached from the sandbox, so it dials in: it keeps a
 * few idle WebSockets ("spares") open on the published ingress port. The
 * runner uses the loopback port as its server origin; every TCP connection it
 * opens there takes one spare, announced with `REVERSE_LINK_OPEN`, and becomes
 * a byte pipe to the server. Nothing above the frame level is parsed: HTTP and
 * the gRPC WebSocket carrier ride through unchanged.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { ByteWriteQueue } from '@funny/shared/lib/byte-write-queue';
import {
  REVERSE_LINK_INGRESS_PORT,
  REVERSE_LINK_LOOPBACK_PORT,
  REVERSE_LINK_MAX_BUFFERED_BYTES,
  REVERSE_LINK_MAX_SPARES,
  REVERSE_LINK_OPEN,
  REVERSE_LINK_PATH,
  REVERSE_LINK_SECRET_ENV,
  REVERSE_LINK_SECRET_HEADER,
} from '@funny/shared/reverse-link';
import type { ServerWebSocket, Socket } from 'bun';

import { log } from '../lib/logger.js';
import { metric } from '../lib/telemetry.js';
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';

export interface ReverseLinkRelayOptions {
  secret: string;
  ingressPort: number;
  loopbackPort: number;
  /** Interface of the ingress listener (the provider proxy connects to it). */
  ingressHost?: string;
  maxSpares?: number;
  maxBufferedBytes?: number;
  /** How long a runner connection waits for a spare before it is dropped. */
  waitForSpareMs?: number;
}

export interface ReverseLinkRelay {
  ingressPort: number;
  loopbackPort: number;
  /** Idle spares, for tests and diagnostics. */
  spareCount(): number;
  close(): void;
}

interface Pipe {
  tcp: Socket<Pipe>;
  ws: ServerWebSocket<SpareData> | null;
  /** Bytes from the runner held until a spare is assigned. */
  toServer: Uint8Array[];
  toServerBytes: number;
  toTcp: ByteWriteQueue;
  closed: boolean;
  waitTimer: ReturnType<typeof setTimeout> | null;
}

interface SpareData {
  pipe: Pipe | null;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

function secretMatches(presented: string | null, expected: Buffer): boolean {
  return !!presented && timingSafeEqual(digest(presented), expected);
}

export function startReverseLinkRelay(options: ReverseLinkRelayOptions): ReverseLinkRelay {
  const expected = digest(options.secret);
  const maxSpares = options.maxSpares ?? REVERSE_LINK_MAX_SPARES;
  const maxBuffered = options.maxBufferedBytes ?? REVERSE_LINK_MAX_BUFFERED_BYTES;
  const waitForSpareMs = options.waitForSpareMs ?? 30_000;
  const spares: ServerWebSocket<SpareData>[] = [];
  const waiting: Pipe[] = [];
  const pipes = new Set<Pipe>();

  const shut = (pipe: Pipe, reason: string) => {
    if (pipe.closed) return;
    pipe.closed = true;
    pipes.delete(pipe);
    if (pipe.waitTimer) clearTimeout(pipe.waitTimer);
    const queued = waiting.indexOf(pipe);
    if (queued >= 0) waiting.splice(queued, 1);
    pipe.toServer.length = 0;
    pipe.toTcp.clear();
    pipe.tcp.end();
    pipe.ws?.close(1000, reason);
  };

  /** Hand `ws` to `pipe`: announce it, then flush what the runner already sent. */
  const pair = (pipe: Pipe, ws: ServerWebSocket<SpareData>) => {
    if (pipe.waitTimer) clearTimeout(pipe.waitTimer);
    pipe.waitTimer = null;
    pipe.ws = ws;
    ws.data.pipe = pipe;
    ws.send(REVERSE_LINK_OPEN);
    for (const chunk of pipe.toServer) ws.send(chunk);
    pipe.toServer.length = 0;
    pipe.toServerBytes = 0;
    metric('reverse_link.relay.paired', 1);
  };

  const ingress = Bun.serve<SpareData>({
    hostname: options.ingressHost ?? '0.0.0.0',
    port: options.ingressPort,
    fetch(req, server) {
      if (new URL(req.url).pathname !== REVERSE_LINK_PATH) {
        return new Response('Not found', { status: 404 });
      }
      if (!secretMatches(req.headers.get(REVERSE_LINK_SECRET_HEADER), expected)) {
        metric('reverse_link.relay.rejected', 1, { attributes: { reason: 'secret' } });
        return new Response('Unauthorized', { status: 401 });
      }
      if (spares.length >= maxSpares) {
        return new Response('Enough spares', { status: 503 });
      }
      if (server.upgrade(req, { data: { pipe: null } })) return undefined;
      return new Response('WebSocket upgrade required', { status: 426 });
    },
    websocket: {
      // Pings keep idle spares alive through the provider's proxy.
      sendPings: true,
      idleTimeout: 60,
      open(ws) {
        const pipe = waiting.shift();
        if (pipe) pair(pipe, ws);
        else spares.push(ws);
      },
      message(ws, message) {
        const pipe = ws.data.pipe;
        if (!pipe || typeof message === 'string') {
          // The server only speaks after `open`, and only in binary frames.
          return ws.close(1003, 'unexpected frame');
        }
        if (pipe.closed) return;
        if (!pipe.toTcp.push(message)) return shut(pipe, 'runner too slow');
        if (!pipe.toTcp.flush(pipe.tcp)) shut(pipe, 'runner closed');
      },
      close(ws) {
        const spare = spares.indexOf(ws);
        if (spare >= 0) spares.splice(spare, 1);
        const pipe = ws.data.pipe;
        if (pipe) shut(pipe, 'server closed');
      },
    },
  });

  const loopback = Bun.listen<Pipe>({
    hostname: '127.0.0.1',
    port: options.loopbackPort,
    socket: {
      open(tcp) {
        const pipe: Pipe = {
          tcp,
          ws: null,
          toServer: [],
          toServerBytes: 0,
          toTcp: new ByteWriteQueue(maxBuffered),
          closed: false,
          waitTimer: null,
        };
        tcp.data = pipe;
        pipes.add(pipe);
        const spare = spares.shift();
        if (spare) return pair(pipe, spare);
        waiting.push(pipe);
        pipe.waitTimer = setTimeout(() => {
          log.warn('Reverse link: no server connection available', {
            namespace: 'reverse-link',
            waitedMs: waitForSpareMs,
          });
          metric('reverse_link.relay.rejected', 1, { attributes: { reason: 'no-spare' } });
          shut(pipe, 'no spare');
        }, waitForSpareMs);
      },
      data(tcp, chunk) {
        const pipe = tcp.data;
        if (pipe.closed) return;
        if (pipe.ws) {
          pipe.ws.send(chunk.slice());
          if (pipe.ws.getBufferedAmount() > maxBuffered) shut(pipe, 'server too slow');
          return;
        }
        if (pipe.toServerBytes + chunk.byteLength > maxBuffered) return shut(pipe, 'no spare');
        pipe.toServer.push(chunk.slice());
        pipe.toServerBytes += chunk.byteLength;
      },
      drain(tcp) {
        const pipe = tcp.data;
        if (!pipe.closed && !pipe.toTcp.flush(tcp)) shut(pipe, 'runner closed');
      },
      close(tcp) {
        shut(tcp.data, 'runner closed');
      },
      error(tcp, error) {
        log.warn('Reverse link loopback socket error', {
          namespace: 'reverse-link',
          error: error.message,
        });
        shut(tcp.data, 'runner error');
      },
    },
  });

  log.info('Reverse link relay listening', {
    namespace: 'reverse-link',
    ingressPort: ingress.port,
    loopbackPort: loopback.port,
  });

  return {
    ingressPort: ingress.port ?? options.ingressPort,
    loopbackPort: loopback.port,
    spareCount: () => spares.length,
    close() {
      for (const pipe of [...pipes]) shut(pipe, 'relay closed');
      for (const ws of spares.splice(0)) ws.close(1001, 'relay closed');
      loopback.stop(true);
      void ingress.stop(true);
    },
  };
}

/**
 * Start the relay when the server set this sandbox up for a reverse link
 * (`FUNNY_REVERSE_LINK_SECRET` in its env). Must run before team mode starts:
 * the runner's `TEAM_SERVER_URL` is the relay's loopback port.
 */
export function startReverseLinkRelayFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReverseLinkRelay | null {
  const secret = env[REVERSE_LINK_SECRET_ENV]?.trim();
  if (!secret) return null;
  const relay = startReverseLinkRelay({
    secret,
    ingressPort: REVERSE_LINK_INGRESS_PORT,
    loopbackPort: REVERSE_LINK_LOOPBACK_PORT,
  });
  shutdownManager.register('reverse-link-relay', () => relay.close(), ShutdownPhase.SERVER);
  return relay;
}
