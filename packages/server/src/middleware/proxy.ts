/**
 * HTTP reverse proxy middleware for the central server.
 *
 * Any /api/* route not handled by native server routes gets forwarded
 * to the appropriate runner via the best available transport:
 *
 * 1. Tunnel (queue + WS accelerator) — used when runner is polling or WS-connected
 * 2. Direct HTTP — used when runner has an httpUrl (e.g. same LAN)
 * 3. 502 — no reachable runner
 *
 * STRICT ISOLATION: The resolver guarantees the runner belongs to the
 * requesting user. If no runner is found, we return 502 immediately.
 *
 * Headers added to proxied requests:
 * - X-Forwarded-User: userId from the authenticated session
 * - X-Forwarded-Org: organizationId (if present)
 * - X-Runner-Auth: shared secret so the runner trusts the server
 */

import type { Context } from 'hono';

import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { isPolling } from '../services/http-tunnel.js';
import { resolveRunner } from '../services/runner-resolver.js';
import { isRunnerConnected } from '../services/ws-relay.js';
import { tunnelFetch } from '../services/ws-tunnel.js';

const RUNNER_AUTH_SECRET = process.env.RUNNER_AUTH_SECRET!;

/**
 * Hono handler that proxies the request to the appropriate runner.
 * Picks the best transport based on runner connectivity state.
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
    log.warn('No reachable runner for proxy request', {
      namespace: 'proxy',
      userId,
      path,
    });
    return c.json({ error: 'No runner connected. Check that your runner is online.' }, 502);
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

  const tunnelPath = `${path}${url.search}`;
  const tunnelActive = isRunnerConnected(runnerId) || isPolling(runnerId);

  // If the tunnel transport is active (WS or polling), use it as primary
  if (tunnelActive) {
    try {
      const tunnelResp = await tunnelFetch(runnerId, {
        method: c.req.method,
        path: tunnelPath,
        headers: forwardedHeaders,
        body,
      });

      return new Response(tunnelResp.body, {
        status: tunnelResp.status,
        headers: new Headers(tunnelResp.headers),
      });
    } catch (tunnelErr) {
      log.warn('Tunnel request failed, trying direct HTTP', {
        namespace: 'proxy',
        runnerId,
        error: (tunnelErr as Error).message,
      });

      if (httpUrl) {
        return await directHttpFetch(c, httpUrl, path, url.search, forwardedHeaders, body);
      }

      return c.json({ error: 'No runner connected. Check that your runner is online.' }, 502);
    }
  }

  // Tunnel not active — try direct HTTP first (instant), queue in tunnel as backup
  if (httpUrl) {
    return await directHttpFetch(c, httpUrl, path, url.search, forwardedHeaders, body);
  }

  // No httpUrl either — queue in tunnel anyway (runner might start polling soon)
  try {
    const tunnelResp = await tunnelFetch(runnerId, {
      method: c.req.method,
      path: tunnelPath,
      headers: forwardedHeaders,
      body,
    });

    return new Response(tunnelResp.body, {
      status: tunnelResp.status,
      headers: new Headers(tunnelResp.headers),
    });
  } catch {
    return c.json({ error: 'No runner connected. Check that your runner is online.' }, 502);
  }
}

/**
 * Direct HTTP fetch to a runner (when httpUrl is available).
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
