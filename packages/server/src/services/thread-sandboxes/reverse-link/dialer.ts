/**
 * Server end of the reverse runner link (`@funny/shared/reverse-link`).
 *
 * Keeps `spares` idle WebSockets open on one sandbox's published ingress. When
 * the relay announces one (`REVERSE_LINK_OPEN`), the runner opened a
 * connection: the dialer connects to the server's own reverse-link listener
 * and pipes bytes both ways, then dials a replacement spare. Failed dials back
 * off exponentially; after `unhealthyAfter` failures in a row `onUnhealthy`
 * fires so the owner can refresh the ingress credentials.
 */

import type { SandboxIngress } from '@funny/sandbox';
import { ByteWriteQueue, frameBytes, type ByteWebSocket } from '@funny/shared/lib/byte-write-queue';
import {
  REVERSE_LINK_MAX_BUFFERED_BYTES,
  REVERSE_LINK_OPEN,
  REVERSE_LINK_PATH,
  REVERSE_LINK_SECRET_HEADER,
  REVERSE_LINK_SPARES,
} from '@funny/shared/reverse-link';

import { log } from '../../../lib/logger.js';
import { metric } from '../../../lib/telemetry.js';
import type { CarrierTcpConnect, CarrierTcpSocket } from '../../grpc/websocket-carrier.js';

export interface ReverseLinkDialerOptions {
  ingress: SandboxIngress;
  secret: string;
  /** The server's reverse-link listener (see `ingress-listener.ts`). */
  target: { hostname: string; port: number };
  spares?: number;
  maxBufferedBytes?: number;
  backoff?: { baseMs: number; maxMs: number };
  unhealthyAfter?: number;
  onUnhealthy?: () => void;
  createWebSocket?: (url: string, headers: Record<string, string>) => ByteWebSocket;
  connect?: CarrierTcpConnect;
  /** Label for logs (never the URL: it may carry a token). */
  label?: string;
}

export interface ReverseLinkDialer {
  spareCount(): number;
  pipeCount(): number;
  close(): void;
}

const WS_OPEN = 1;
/** A spare that lived this long was healthy: its close is not a failure. */
const HEALTHY_SPARE_MS = 30_000;

/** `wss://<ingress host><REVERSE_LINK_PATH>?<ingress query>`. */
export function reverseLinkUrl(ingressUrl: string): string {
  const url = new URL(ingressUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = REVERSE_LINK_PATH;
  url.hash = '';
  return url.toString();
}

const defaultCreateWebSocket = (url: string, headers: Record<string, string>) =>
  // Bun's WebSocket accepts request headers.
  new WebSocket(url, { headers } as any) as unknown as ByteWebSocket;

const defaultConnect: CarrierTcpConnect = ({ hostname, port, handlers }) =>
  Bun.connect({ hostname, port, socket: handlers });

interface Link {
  ws: ByteWebSocket;
  openedAt: number | null;
  /** Set once the relay assigned this socket to a runner connection. */
  piped: boolean;
  tcp: CarrierTcpSocket | null;
  toTcp: ByteWriteQueue;
  closed: boolean;
}

export function startReverseLinkDialer(options: ReverseLinkDialerOptions): ReverseLinkDialer {
  const spares = options.spares ?? REVERSE_LINK_SPARES;
  const maxBuffered = options.maxBufferedBytes ?? REVERSE_LINK_MAX_BUFFERED_BYTES;
  const backoff = options.backoff ?? { baseMs: 1_000, maxMs: 30_000 };
  const unhealthyAfter = options.unhealthyAfter ?? 5;
  const createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;
  const connect = options.connect ?? defaultConnect;
  const url = reverseLinkUrl(options.ingress.url);
  const headers = { ...options.ingress.headers, [REVERSE_LINK_SECRET_HEADER]: options.secret };
  const label = options.label ?? 'sandbox';

  const links = new Set<Link>();
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const idleCount = () => [...links].filter((l) => !l.piped).length;

  const shut = (link: Link, reason: string) => {
    if (link.closed) return;
    link.closed = true;
    links.delete(link);
    link.toTcp.clear();
    link.tcp?.end();
    if (link.ws.readyState <= WS_OPEN) link.ws.close(1000, reason);
  };

  const scheduleFill = () => {
    if (stopped || retryTimer) return;
    if (failures === 0) return fill();
    const ms = Math.min(backoff.maxMs, backoff.baseMs * 2 ** (failures - 1));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      fill();
    }, ms);
  };

  const failed = () => {
    failures += 1;
    metric('reverse_link.dialer.failed', 1);
    if (failures === unhealthyAfter) {
      log.warn('Reverse link: sandbox unreachable', { namespace: 'reverse-link', label, failures });
      options.onUnhealthy?.();
    }
  };

  /** The relay handed this spare to a runner connection: connect it to the server. */
  const startPipe = (link: Link) => {
    link.piped = true;
    failures = 0;
    metric('reverse_link.dialer.piped', 1);
    connect({
      ...options.target,
      handlers: {
        open(socket) {
          if (link.closed) return socket.end();
          link.tcp = socket;
          if (!link.toTcp.flush(socket)) shut(link, 'server closed');
        },
        data(_socket, chunk) {
          if (link.closed) return;
          link.ws.send(chunk.slice());
          if (link.ws.bufferedAmount > maxBuffered) shut(link, 'sandbox too slow');
        },
        drain(socket) {
          if (!link.closed && !link.toTcp.flush(socket)) shut(link, 'server closed');
        },
        close() {
          shut(link, 'server closed');
        },
        error(_socket, error) {
          log.warn('Reverse link server socket error', {
            namespace: 'reverse-link',
            label,
            error: error.message,
          });
          shut(link, 'server error');
        },
      },
    }).catch((error: unknown) => {
      log.error('Reverse link could not reach the server listener', {
        namespace: 'reverse-link',
        label,
        error: error instanceof Error ? error.message : String(error),
      });
      shut(link, 'server unavailable');
    });
    // Keep the pool full for the runner's next connection.
    fill();
  };

  const dial = () => {
    const ws = createWebSocket(url, headers);
    ws.binaryType = 'arraybuffer';
    const link: Link = {
      ws,
      openedAt: null,
      piped: false,
      tcp: null,
      toTcp: new ByteWriteQueue(maxBuffered),
      closed: false,
    };
    links.add(link);
    ws.onopen = () => {
      link.openedAt = Date.now();
      failures = 0;
    };
    ws.onmessage = (event) => {
      if (link.closed) return;
      if (!link.piped) {
        if (event.data === REVERSE_LINK_OPEN) return startPipe(link);
        return shut(link, 'unexpected frame');
      }
      const bytes = frameBytes(event.data);
      if (!bytes) return shut(link, 'unexpected text frame');
      if (!link.toTcp.push(bytes)) return shut(link, 'server too slow');
      if (link.tcp && !link.toTcp.flush(link.tcp)) shut(link, 'server closed');
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      const wasIdle = !link.piped;
      const healthy = link.openedAt !== null && Date.now() - link.openedAt >= HEALTHY_SPARE_MS;
      shut(link, 'sandbox closed');
      if (stopped || !wasIdle) return;
      if (!healthy) failed();
      scheduleFill();
    };
  };

  function fill() {
    if (stopped) return;
    for (let idle = idleCount(); idle < spares; idle++) dial();
  }

  fill();

  return {
    spareCount: idleCount,
    pipeCount: () => [...links].filter((l) => l.piped).length,
    close() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      for (const link of [...links]) shut(link, 'link closed');
    },
  };
}
