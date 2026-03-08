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
import { matchedRoutes } from 'hono/route';

import { metric, recordHistogram, startSpan, type SpanHandle } from '../lib/telemetry.js';

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

  // Parse incoming W3C traceparent header
  const incoming = parseTraceparent(c.req.header('traceparent') ?? null);

  // Start the span early with a placeholder name — we'll update it after routing
  const _startTime = Date.now();
  const span = startSpan(`${method} ${c.req.path}`, {
    traceId: incoming?.traceId,
    parentSpanId: incoming?.parentSpanId,
    attributes: {
      'http.method': method,
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

  // Resolve the actual matched route pattern (e.g. /api/projects/:id)
  // After next(), matchedRoutes() returns all matched handlers including middleware.
  // The last non-wildcard entry is the actual route handler.
  const route = resolveRoute(c) || c.req.path;

  const status = c.res.status;
  const isError = status >= 500;

  // Update span name to the resolved route
  span.name = `${method} ${route}`;
  span.attributes['http.route'] = route;
  span.end(isError ? 'error' : 'ok', isError ? `HTTP ${status}` : undefined);

  const durationMs = span.durationMs ?? 0;

  recordHistogram('http.server.duration', durationMs, {
    unit: 'ms',
    attributes: { method, route },
  });

  metric('http.server.requests', 1, {
    type: 'sum',
    attributes: { method, route, status },
  });
}

/**
 * Create a child span linked to the current request's parent HTTP span.
 * Use this in route handlers to trace internal operations (DB queries, git, etc.).
 *
 * @example
 * ```ts
 * app.get('/api/projects/:id', async (c) => {
 *   const span = requestSpan(c, 'db.query', { table: 'projects' });
 *   const project = db.select().from(projects).where(...);
 *   span.end('ok');
 *   return c.json(project);
 * });
 * ```
 */
export function requestSpan(
  c: Context,
  name: string,
  attributes?: Record<string, unknown>,
): SpanHandle {
  return startSpan(name, {
    traceId: c.get('traceId'),
    parentSpanId: c.get('spanId'),
    attributes,
  });
}

/**
 * Resolve the actual route pattern from matched routes.
 * Hono stores the full merged path in `route.path` (basePath is already included),
 * so we just need to find the last non-wildcard handler route.
 */
function resolveRoute(c: Context): string | null {
  try {
    const routes = matchedRoutes(c);
    if (!routes.length) return null;

    // Find the last route that isn't a wildcard middleware pattern
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i];
      // Hono's route.path already includes the full path (basePath + handler path merged)
      if (r.path !== '/*' && !r.path.endsWith('/*')) {
        return r.path || '/';
      }
    }

    // All routes were wildcards — fall back to the last one's path
    return routes[routes.length - 1].path || '/*';
  } catch {
    return null;
  }
}
