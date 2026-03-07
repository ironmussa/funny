/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * HTTP tracing middleware — records a span + metrics for every API request.
 * Supports W3C Trace Context propagation (traceparent header) and tracks
 * active in-flight requests via an UpDownCounter-style gauge.
 */

import type { Context, Next } from 'hono';

import { metric, recordHistogram, startSpan } from '../lib/telemetry.js';

// ── W3C Trace Context parsing ────────────────────────────────────
// https://www.w3.org/TR/trace-context/#traceparent-header-field-values
// Format: version-traceId-parentId-traceFlags  (e.g. 00-<32hex>-<16hex>-01)
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function parseTraceparent(header: string | null): { traceId: string; parentSpanId: string } | null {
  if (!header) return null;
  const m = header.match(TRACEPARENT_RE);
  if (!m) return null;
  return { traceId: m[1], parentSpanId: m[2] };
}

// ── Active request counter ───────────────────────────────────────
let activeRequests = 0;

/**
 * Hono middleware that automatically traces HTTP requests.
 *
 * For each request it:
 * - Extracts W3C traceparent header to propagate trace context
 * - Creates a span with method, route, status, and duration
 * - Sets a traceparent response header for downstream correlation
 * - Tracks active in-flight requests (http.server.active_requests gauge)
 * - Records `http.server.duration` histogram (ms)
 * - Records `http.server.requests` counter (by method + status)
 */
export async function tracingMiddleware(c: Context, next: Next) {
  const method = c.req.method;
  const route = c.req.routePath || c.req.path;

  // Parse incoming W3C traceparent header
  const incoming = parseTraceparent(c.req.header('traceparent') ?? null);

  const span = startSpan(`${method} ${route}`, {
    traceId: incoming?.traceId,
    parentSpanId: incoming?.parentSpanId,
    attributes: {
      'http.method': method,
      'http.route': route,
      'http.url': c.req.path,
    },
  });

  // Store trace context on Hono context for downstream route handlers
  c.set('traceId', span.traceId);
  c.set('spanId', span.spanId);

  // Set response traceparent so the client can correlate
  c.header('traceparent', `00-${span.traceId}-${span.spanId}-01`);

  // Track active requests
  activeRequests++;
  metric('http.server.active_requests', activeRequests, { type: 'gauge' });

  await next();

  activeRequests--;
  metric('http.server.active_requests', activeRequests, { type: 'gauge' });

  const status = c.res.status;
  const isError = status >= 500;

  span.end(isError ? 'error' : 'ok', isError ? `HTTP ${status}` : undefined);

  const attrs = { method, route, status };

  const durationMs = span.durationMs ?? 0;

  recordHistogram('http.server.duration', durationMs, {
    unit: 'ms',
    attributes: { method, route },
  });

  metric('http.server.requests', 1, {
    type: 'sum',
    attributes: attrs,
  });
}
