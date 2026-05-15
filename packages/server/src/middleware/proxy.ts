/**
 * HTTP reverse proxy middleware for the central server.
 *
 * Any /api/* route not handled by native server routes gets forwarded
 * to the appropriate runner via the best available transport:
 *
 * 1. Direct HTTP — preferred when runner has an httpUrl (simple, reliable)
 * 2. WS tunnel — used when runner has no httpUrl (behind NAT)
 * 3. 502 — no reachable runner
 *
 * When WS_TUNNEL_ONLY=true, direct HTTP is disabled and all requests
 * go through the WS tunnel (for testing WS stability).
 *
 * STRICT ISOLATION: The resolver guarantees the runner belongs to the
 * requesting user. If no runner is found, we return 502 immediately.
 *
 * Headers added to proxied requests:
 * - X-Forwarded-User: userId from the authenticated session
 * - X-Forwarded-Org: organizationId (if present)
 * - X-Runner-Auth: shared secret so the runner trusts the server
 * - X-Forwarded-Signature / X-Forwarded-Timestamp: HMAC-SHA256 over the
 *   forwarded identity, proving the headers came from the server (not from
 *   a client that happens to know the shared secret).
 */

import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import type { Context } from 'hono';

import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { resolveAnyRunner, resolveRunner } from '../services/runner-resolver.js';
import { isRunnerConnected } from '../services/ws-relay.js';
import { TunnelTimeoutError, tunnelFetch } from '../services/ws-tunnel.js';

const RUNNER_AUTH_SECRET = process.env.RUNNER_AUTH_SECRET!;

/**
 * Hono handler that proxies the request to the appropriate runner.
 * Picks the best transport based on runner connectivity state.
 */
export async function proxyToRunner(c: Context<ServerEnv>): Promise<Response> {
  const userId = c.get('userId') as string | undefined;

  const url = new URL(c.req.url);
  const path = url.pathname;

  // MCP OAuth callback: the external provider redirects the browser here without
  // any session cookie. The runtime validates the state parameter to ensure only
  // the correct flow is completed. Resolve any connected runner (no user scoping).
  const isOAuthCallback = path === '/api/mcp/oauth/callback';

  if (!userId && !isOAuthCallback) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Resolve which runner should handle this request.
  // OAuth callbacks are unauthenticated (external redirect) — find any runner.
  // All other requests are scoped to the requesting user.
  const query = Object.fromEntries(url.searchParams.entries());
  const resolved = isOAuthCallback
    ? await resolveAnyRunner()
    : await resolveRunner(path, query, userId);

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
    'X-Runner-Auth': RUNNER_AUTH_SECRET,
    'content-type': c.req.header('content-type') || 'application/json',
  };
  if (userId) {
    forwardedHeaders['X-Forwarded-User'] = userId;
  }

  // Forward the original host so the runtime can reconstruct public-facing URLs
  // (e.g., OAuth callback redirects). Prefer an existing X-Forwarded-Host (set by
  // reverse proxies like Vite dev server), otherwise use the request's Host header.
  const fwdHost = c.req.header('X-Forwarded-Host') || c.req.header('Host');
  if (fwdHost) {
    forwardedHeaders['X-Forwarded-Host'] = fwdHost;
  }
  const fwdProto = c.req.header('X-Forwarded-Proto') || url.protocol.replace(':', '');
  if (fwdProto) {
    forwardedHeaders['X-Forwarded-Proto'] = fwdProto;
  }

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

  // HMAC-sign the forwarded identity so the runtime can distinguish a real
  // server-proxied request from a spoofed one carrying the shared secret.
  if (userId) {
    const { signature, timestamp } = signForwardedIdentity(
      { userId, role: userRole ?? null, orgId: orgId ?? null, orgName: orgName ?? null },
      RUNNER_AUTH_SECRET,
    );
    forwardedHeaders[SIGNATURE_HEADER] = signature;
    forwardedHeaders[TIMESTAMP_HEADER] = String(timestamp);
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
  const tunnelActive = isRunnerConnected(runnerId);

  // If the runner is connected via Socket.IO, use the tunnel as primary
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
      // On timeout, the runner already received the request and may still be
      // processing it. Falling back to direct HTTP would deliver the request
      // a second time and duplicate side effects (e.g., persisting a user
      // message twice and enqueuing two prompts on agents that await the
      // full turn in sendPrompt — Gemini/Codex/Pi). Surface 504 instead.
      if (
        tunnelErr instanceof TunnelTimeoutError ||
        (tunnelErr instanceof Error && tunnelErr.name === 'TunnelTimeoutError')
      ) {
        log.warn('Tunnel request timed out — not falling back', {
          namespace: 'proxy',
          runnerId,
          path,
          method: c.req.method,
          timeoutMs: (tunnelErr as any).timeoutMs || 30_000,
        });
        return c.json(
          { error: 'Runner did not respond in time. The request may still be processing.' },
          504,
        );
      }
      log.warn('Tunnel request failed', {
        namespace: 'proxy',
        runnerId,
        error: (tunnelErr as Error).message,
      });
    }
  }

  // Runner not connected via Socket.IO — try direct HTTP if available
  if (httpUrl) {
    try {
      return await directHttpFetch(c, httpUrl, path, url.search, forwardedHeaders, body);
    } catch (httpErr) {
      log.warn('Direct HTTP to runner failed', {
        namespace: 'proxy',
        runnerId,
        error: (httpErr as Error).message,
      });
    }
  }

  return c.json({ error: 'No runner connected. Check that your runner is online.' }, 502);
}

/**
 * Direct HTTP fetch to a runner (when httpUrl is available).
 * Throws on network errors so the caller can fall through to the tunnel.
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

  const headers = new Headers();
  for (const [key, value] of Object.entries(forwardedHeaders)) {
    headers.set(key, value);
  }

  const runnerResponse = await fetch(targetUrl, {
    method: c.req.method,
    headers,
    body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? body : undefined,
  });

  // Security M5: do not forward arbitrary response headers from the runner.
  // A malicious runner could otherwise set `Set-Cookie` on the server's
  // origin, poison `Access-Control-*` to relax CORS, or trip `Strict-
  // Transport-Security` / `Content-Security-Policy` on the central server.
  // Allowlist only payload-describing headers that the client legitimately
  // needs to render the response.
  return new Response(runnerResponse.body, {
    status: runnerResponse.status,
    statusText: runnerResponse.statusText,
    headers: filterSafeRunnerResponseHeaders(runnerResponse.headers),
  });
}

/**
 * Headers we accept back from a runner. Kept deliberately narrow — if a new
 * legitimate header shows up, add it explicitly rather than loosening this
 * list. Any `Set-Cookie` / `Access-Control-*` / `Authorization` / security-
 * policy header from the runner is silently dropped.
 */
const SAFE_RUNNER_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'content-disposition',
  'content-language',
  'cache-control',
  'etag',
  'last-modified',
  'vary',
  'x-content-type-options',
]);

function filterSafeRunnerResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (SAFE_RUNNER_RESPONSE_HEADERS.has(key.toLowerCase())) {
      out.set(key, value);
    }
  });
  return out;
}
