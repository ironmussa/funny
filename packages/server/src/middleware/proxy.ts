/**
 * HTTP reverse proxy middleware for the central server.
 *
 * Any /api/* route not handled by native server routes gets forwarded
 * to the appropriate runner. Uses WebSocket tunnel as the primary transport
 * (works behind NAT), with direct HTTP as a fallback when httpUrl is available.
 *
 * Headers added to proxied requests:
 * - X-Forwarded-User: userId from the authenticated session
 * - X-Forwarded-Org: organizationId (if present)
 * - X-Runner-Auth: shared secret so the runner trusts the server
 */

import type { Context } from 'hono';

import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { resolveRunner } from '../services/runner-resolver.js';
import { tunnelFetch } from '../services/ws-tunnel.js';

const RUNNER_AUTH_SECRET = process.env.RUNNER_AUTH_SECRET!;

/**
 * Hono handler that proxies the request to the appropriate runner
 * via WebSocket tunnel or direct HTTP.
 */
export async function proxyToRunner(c: Context<ServerEnv>): Promise<Response> {
  const userId = c.get('userId') as string | undefined;
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(c.req.url);
  const path = url.pathname;

  // Resolve which runner should handle this request (scoped to requesting user)
  const query = Object.fromEntries(url.searchParams.entries());
  const resolved = await resolveRunner(path, query, userId);

  if (!resolved) {
    return c.json(
      {
        error:
          'No runner available for this request. Check that a runner is online and assigned to the project.',
      },
      502,
    );
  }

  const { runnerId, httpUrl } = resolved;

  // Build forwarded headers
  const forwardedHeaders: Record<string, string> = {
    'X-Forwarded-User': userId,
    'X-Runner-Auth': RUNNER_AUTH_SECRET,
    'content-type': c.req.header('content-type') || 'application/json',
  };

  const orgId = c.get('organizationId') as string | undefined;
  if (orgId) {
    forwardedHeaders['X-Forwarded-Org'] = orgId;
  }

  const orgName = c.get('organizationName') as string | undefined;
  if (orgName) {
    forwardedHeaders['X-Forwarded-Org-Name'] = orgName;
  }

  const userRole = c.get('userRole') as string | undefined;
  if (userRole) {
    forwardedHeaders['X-Forwarded-Role'] = userRole;
  }

  // Read body for non-GET/HEAD requests
  let body: string | null = null;
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    try {
      body = await c.req.text();
    } catch {
      body = null;
    }
  }

  // Special case: __default__ runnerId means we're using DEFAULT_RUNNER_URL (always direct HTTP)
  if (runnerId === '__default__' && httpUrl) {
    return await directHttpFetch(c, httpUrl, path, url.search, forwardedHeaders, body);
  }

  // Primary: try WebSocket tunnel
  try {
    const tunnelResp = await tunnelFetch(runnerId, {
      method: c.req.method,
      path: `${path}${url.search}`,
      headers: forwardedHeaders,
      body,
    });

    const responseHeaders = new Headers(tunnelResp.headers);
    return new Response(tunnelResp.body, {
      status: tunnelResp.status,
      headers: responseHeaders,
    });
  } catch (tunnelErr) {
    log.warn('Tunnel request failed, trying direct HTTP fallback', {
      namespace: 'proxy',
      runnerId,
      error: (tunnelErr as Error).message,
    });

    // Fallback: direct HTTP (only if httpUrl is set)
    if (httpUrl) {
      return await directHttpFetch(c, httpUrl, path, url.search, forwardedHeaders, body);
    }

    return c.json({ error: 'Runner unreachable (no tunnel connection and no direct URL)' }, 502);
  }
}

/**
 * Direct HTTP fetch to a runner (fallback when tunnel fails or for __default__).
 */
async function directHttpFetch(
  c: Context<ServerEnv>,
  httpUrl: string,
  path: string,
  search: string,
  forwardedHeaders: Record<string, string>,
  body: string | null,
): Promise<Response> {
  const targetUrl = `${httpUrl}${path}${search}`;

  try {
    const headers = new Headers(c.req.raw.headers);
    for (const [key, value] of Object.entries(forwardedHeaders)) {
      headers.set(key, value);
    }
    headers.delete('cookie');
    headers.delete('authorization');

    const runnerResponse = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? body : undefined,
    });

    return new Response(runnerResponse.body, {
      status: runnerResponse.status,
      statusText: runnerResponse.statusText,
      headers: runnerResponse.headers,
    });
  } catch (err) {
    log.error('Failed to proxy request to runner via direct HTTP', {
      namespace: 'proxy',
      targetUrl,
      error: (err as Error).message,
    });
    return c.json({ error: 'Runner unreachable' }, 502);
  }
}
