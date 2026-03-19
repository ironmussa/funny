/**
 * Unified tunnel for proxying HTTP requests to runners.
 *
 * Every request is ALWAYS queued in the HTTP tunnel (for poll-based pickup).
 * If the runner has an active WebSocket, the request is ALSO pushed via WS
 * for lower latency. The runner deduplicates by requestId.
 *
 * Responses can arrive via either channel:
 * - WS: runner sends tunnel:response message
 * - HTTP: runner POSTs to /api/runners/tunnel/result
 * Both resolve the same pending Promise via handleTunnelResponse().
 */

import type { CentralWSTunnelRequest } from '@funny/shared/runner-protocol';
import { nanoid } from 'nanoid';

import { log } from '../lib/logger.js';
import { enqueueRequest } from './http-tunnel.js';
import { sendToRunner } from './ws-relay.js';

const TUNNEL_TIMEOUT_MS = 30_000;

interface PendingRequest {
  runnerId: string;
  resolve: (response: TunnelResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

/** requestId → pending request */
const pending = new Map<string, PendingRequest>();

/**
 * Send an HTTP request to a runner through the tunnel.
 * Returns a Response-like object with status, headers, and body.
 *
 * The request is always queued for HTTP poll pickup.
 * If WS is connected, it's also pushed for lower latency.
 * The response can arrive from either channel.
 */
export function tunnelFetch(
  runnerId: string,
  opts: { method: string; path: string; headers: Record<string, string>; body?: string | null },
): Promise<TunnelResponse> {
  const requestId = nanoid();

  const pollItem = {
    requestId,
    method: opts.method,
    path: opts.path,
    headers: opts.headers,
    body: opts.body ?? null,
  };

  // 1. ALWAYS queue for HTTP poll pickup (reliable baseline)
  enqueueRequest(runnerId, pollItem);

  // 2. Opportunistically push via WS (best-effort accelerator)
  const wsMessage: CentralWSTunnelRequest = {
    type: 'tunnel:request',
    ...pollItem,
  };
  sendToRunner(runnerId, wsMessage as unknown as Record<string, unknown>);
  // Ignore send failure — the request is already queued for poll

  // 3. Wait for response (arrives via WS tunnel:response OR HTTP POST /tunnel/result)
  return new Promise<TunnelResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(
        new Error(
          `Tunnel request ${requestId} to runner ${runnerId} timed out after ${TUNNEL_TIMEOUT_MS}ms`,
        ),
      );
    }, TUNNEL_TIMEOUT_MS);

    pending.set(requestId, { runnerId, resolve, reject, timer });
  });
}

/**
 * Handle a tunnel response (from either WS or HTTP).
 * Called by the server WS message handler and the POST /tunnel/result route.
 */
export function handleTunnelResponse(data: {
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
}): void {
  const entry = pending.get(data.requestId);
  if (!entry) {
    log.warn('Received tunnel response for unknown requestId', {
      namespace: 'tunnel',
      requestId: data.requestId,
    });
    return;
  }

  clearTimeout(entry.timer);
  pending.delete(data.requestId);

  entry.resolve({
    status: data.status,
    headers: data.headers,
    body: data.body,
  });
}

/**
 * Cancel all pending tunnel requests for a runner.
 * Only call when the runner is truly unreachable (no WS AND no polling).
 */
export function cancelPendingRequests(runnerId: string): void {
  let cancelled = 0;
  for (const [requestId, entry] of pending) {
    if (entry.runnerId !== runnerId) continue;
    clearTimeout(entry.timer);
    entry.reject(new Error(`Runner ${runnerId} disconnected`));
    pending.delete(requestId);
    cancelled++;
  }
  if (cancelled > 0) {
    log.info(`Cancelled ${cancelled} pending tunnel requests for runner ${runnerId}`, {
      namespace: 'tunnel',
    });
  }
}

/**
 * Get the number of pending tunnel requests (for monitoring).
 */
export function getPendingCount(): number {
  return pending.size;
}
