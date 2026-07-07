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
 *   forwarded identity, proving the sender HOLDS the shared secret (so a
 *   caller WITHOUT it — e.g. a browser hitting a runner directly — cannot
 *   forge the headers). It does not distinguish the server from a runner that
 *   holds the same secret; see the trust-boundary note in
 *   `@funny/shared/auth/forwarded-identity`.
 */

import {
  NONCE_HEADER,
  ON_BEHALF_OF_THREAD_HEADER,
  SHARE_LEVEL_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import type { Context } from 'hono';

import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import * as runnerResolver from '../services/runner-resolver.js';
import * as wsRelay from '../services/ws-relay.js';
import * as wsTunnel from '../services/ws-tunnel.js';

/**
 * Transport dependencies the proxy uses to reach a runner. Injectable so tests
 * can supply deterministic fakes directly, without Bun's process-global
 * `mock.module` (which leaks across test files and makes the tunnel-timeout
 * assertions flaky). Production uses `defaultTransport`, whose members delegate
 * to the real service singletons at call time.
 */
/** Minimal HTTP-client shape (avoids `typeof fetch`, which carries Bun-only
 *  statics like `preconnect` that a test fake can't satisfy). */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ProxyTransport {
  resolveRunner: typeof runnerResolver.resolveRunner;
  resolveAnyRunner: typeof runnerResolver.resolveAnyRunner;
  isRunnerConnected: typeof wsRelay.isRunnerConnected;
  tunnelFetch: typeof wsTunnel.tunnelFetch;
  isTunnelTimeoutError: (err: unknown) => boolean;
  /** HTTP client for the direct-to-runner path. Injectable so tests don't have
   *  to override the process-global `fetch` (which other concurrent test files
   *  share). */
  directFetch: FetchLike;
}

const defaultTransport: ProxyTransport = {
  resolveRunner: (...args) => runnerResolver.resolveRunner(...args),
  resolveAnyRunner: (...args) => runnerResolver.resolveAnyRunner(...args),
  isRunnerConnected: (...args) => wsRelay.isRunnerConnected(...args),
  tunnelFetch: (...args) => wsTunnel.tunnelFetch(...args),
  isTunnelTimeoutError: (err) => wsTunnel.isTunnelTimeoutError(err),
  directFetch: (input, init) => fetch(input, init),
};

function getRunnerAuthSecret(): string {
  const secret = process.env.RUNNER_AUTH_SECRET;
  if (!secret) {
    throw new Error('RUNNER_AUTH_SECRET is not set');
  }
  return secret;
}

/**
 * Build a Hono proxy handler bound to the given transport. Pass fake deps in
 * tests for deterministic behaviour; production calls it with no args.
 */
export function createProxyToRunner(deps: ProxyTransport = defaultTransport) {
  return (c: Context<ServerEnv>): Promise<Response> => proxyToRunnerImpl(c, deps);
}

/** Default production handler, wired to the real transport. */
export const proxyToRunner = createProxyToRunner();

/**
 * Hono handler that proxies the request to the appropriate runner.
 * Picks the best transport based on runner connectivity state.
 */
async function proxyToRunnerImpl(c: Context<ServerEnv>, deps: ProxyTransport): Promise<Response> {
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

  // ── Steer-share delegation (thread-sharing-steer) ──────────────────────
  // The runner-isolation invariant routes a request ONLY to the requester's
  // own runner. The single intentional exception: when an ALLOW-LISTED route
  // (`POST /:id/message`, read-only git GETs) has already authorized a `steer`
  // sharee, the upstream middleware (`requireThreadSteer`) loaded the thread
  // into context. The thread lives on its OWNER's runner, so we resolve by the
  // owner's id — never a blind fallback. Reaching here as a non-owner means the
  // gate passed; we resolve by owner and AUDIT the crossing. Routes NOT guarded
  // by a thread-access middleware never set `thread`, so they can never trigger
  // this path. See CLAUDE.md "Runner Isolation (CRITICAL)".
  const thread = c.get('thread') as ServerEnv['Variables']['thread'] | undefined;
  let resolveUserId = userId;
  if (thread && userId && thread.userId && thread.userId !== userId) {
    resolveUserId = thread.userId;
    audit({
      action: 'share.steer_delegation',
      actorId: userId,
      detail: `sharee routed to owner runner for ${c.req.method} ${path}`,
      meta: { threadId: thread.id, ownerId: thread.userId, method: c.req.method, path },
    });
  }

  // Resolve which runner should handle this request.
  // OAuth callbacks are unauthenticated (external redirect) — find any runner.
  // All other requests are scoped to the requesting user (or, for an authorized
  // steer sharee, the thread owner — see delegation above).
  const query = Object.fromEntries(url.searchParams.entries());
  const resolved = isOAuthCallback
    ? await deps.resolveAnyRunner()
    : await deps.resolveRunner(path, query, resolveUserId);

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
    'X-Runner-Auth': getRunnerAuthSecret(),
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

  // Forward the client's Range so the runner can answer media requests with
  // 206 Partial Content. Without this the runtime never sees a range and always
  // returns the full 200 body — breaking <video>/<audio> seek and any MP4 whose
  // `moov` atom sits at the end (the browser must range-read it to start
  // playback). The matching response headers (Accept-Ranges / Content-Range)
  // are allowlisted in SAFE_RUNNER_RESPONSE_HEADERS.
  const rangeHeader = c.req.header('range');
  if (rangeHeader) {
    forwardedHeaders['range'] = rangeHeader;
  }

  const orgId = c.get('organizationId') as string | undefined;
  if (orgId) {
    forwardedHeaders['X-Forwarded-Org'] = orgId;
  }

  const orgName = c.get('organizationName') as string | undefined;
  if (orgName) {
    forwardedHeaders['X-Forwarded-Org-Name'] = orgName;
  }

  // Always forward a role (default 'user') so the signed payload matches what
  // the runtime verifies — the runtime defaults a missing X-Forwarded-Role to
  // 'user', and any divergence between signer and verifier breaks the HMAC.
  const userRole = (c.get('userRole') as string | undefined) || 'user';
  forwardedHeaders['X-Forwarded-Role'] = userRole;

  // When this request was delegated to the owner's runner for a steer sharee
  // (see above), bind a signed `steer` claim for the thread. The runtime has no
  // DB to look up the grant — it trusts this signed claim (the server set it
  // only after requireThreadSteer verified the grant) to authorize the sharee.
  const isSteerDelegation = !!thread && resolveUserId !== userId;
  const shareLevel = isSteerDelegation ? 'steer' : null;
  const onBehalfOfThread = isSteerDelegation ? thread!.id : null;
  if (isSteerDelegation) {
    forwardedHeaders[SHARE_LEVEL_HEADER] = 'steer';
    forwardedHeaders[ON_BEHALF_OF_THREAD_HEADER] = thread!.id;
  }

  // HMAC-sign the forwarded identity so the runtime can distinguish a real
  // server-proxied request from a spoofed one carrying the shared secret.
  //
  // CRITICAL: the signature carries a single-use nonce that the runtime records
  // in a replay cache once the HMAC verifies. If we signed ONCE and reused the
  // same headers across a transport fallback (direct HTTP → tunnel), a first
  // attempt that reached the runtime but whose response failed to deliver (e.g.
  // "socket connection was closed unexpectedly" on a loopback keep-alive socket)
  // would have already burned the nonce — so the retry over the other transport
  // is rejected as a replay ("invalid signature") and the caller sees a spurious
  // 401. We therefore mint a FRESH nonce/signature for every physical send.
  const signedIdentity = userId
    ? {
        userId,
        role: userRole,
        orgId: orgId ?? null,
        orgName: orgName ?? null,
        shareLevel,
        onBehalfOfThread,
      }
    : null;
  /** Clone the forwarded headers with a freshly-signed identity (new nonce). */
  const withFreshSignature = (): Record<string, string> => {
    if (!signedIdentity) return { ...forwardedHeaders };
    const { signature, timestamp, nonce } = signForwardedIdentity(
      signedIdentity,
      getRunnerAuthSecret(),
    );
    return {
      ...forwardedHeaders,
      [SIGNATURE_HEADER]: signature,
      [TIMESTAMP_HEADER]: String(timestamp),
      [NONCE_HEADER]: nonce,
    };
  };

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
  const tunnelActive = deps.isRunnerConnected(runnerId);

  // Safe (idempotent, side-effect-free) methods may be retried across
  // transports without risk of duplicating work. Unsafe methods (POST/PUT/…)
  // must not be replayed after a tunnel timeout — see the timeout handler below.
  const isSafeMethod = c.req.method === 'GET' || c.req.method === 'HEAD';

  // Local bunx/dev runs register a loopback httpUrl. Prefer direct HTTP for
  // those requests so regular API calls do not compete with high-volume agent
  // stream persistence over the Socket.IO tunnel.
  const preferDirectHttp = httpUrl ? isLoopbackRunnerUrl(httpUrl) : false;

  if (preferDirectHttp && httpUrl) {
    try {
      return await directHttpFetch(
        c,
        httpUrl,
        path,
        url.search,
        withFreshSignature(),
        body,
        deps.directFetch,
      );
    } catch (httpErr) {
      log.warn('Direct HTTP to local runner failed; trying tunnel', {
        namespace: 'proxy',
        runnerId,
        error: (httpErr as Error).message,
      });
    }
  }

  // If the runner is connected via Socket.IO, use the tunnel as primary
  if (tunnelActive) {
    try {
      const tunnelResp = await deps.tunnelFetch(runnerId, {
        method: c.req.method,
        path: tunnelPath,
        headers: withFreshSignature(),
        body,
      });

      // A binary response (image, video, PDF…) arrives base64-encoded so its
      // bytes survive the JSON ack — decode it back to raw bytes here. A text
      // response (the common JSON API payload) is passed through verbatim.
      const tunnelBody =
        tunnelResp.bodyEncoding === 'base64' && tunnelResp.body != null
          ? Buffer.from(tunnelResp.body, 'base64')
          : tunnelResp.body;

      // Security M5: filter runner response headers on the tunnel path too —
      // not just direct HTTP. The tunnel is the primary transport whenever the
      // runner is connected, so leaving it unfiltered let a malicious runner
      // set `Set-Cookie` / `Access-Control-*` / security-policy headers on the
      // central server's origin for the requesting user's browser.
      return new Response(tunnelBody, {
        status: tunnelResp.status,
        headers: filterSafeRunnerResponseHeaders(new Headers(tunnelResp.headers)),
      });
    } catch (tunnelErr) {
      // On timeout, the runner already received the request and may still be
      // processing it. For UNSAFE methods, falling back to direct HTTP would
      // deliver the request a second time and duplicate side effects (e.g.,
      // persisting a user message twice and enqueuing two prompts on agents
      // that await the full turn in sendPrompt — Gemini/Codex/Pi). Surface 504.
      //
      // Safe methods (GET/HEAD — e.g. /api/files/read) are idempotent and have
      // no side effects, so a tunnel timeout should NOT dead-end at 504: fall
      // through to the direct-HTTP block below and retry. This is what makes a
      // transient tunnel stall on a plain file read recover instead of
      // surfacing a spurious error to the user.
      if (deps.isTunnelTimeoutError(tunnelErr)) {
        if (isSafeMethod && httpUrl) {
          log.warn('Tunnel request timed out — retrying safe method over direct HTTP', {
            namespace: 'proxy',
            runnerId,
            path,
            method: c.req.method,
            timeoutMs: (tunnelErr as any).timeoutMs || 30_000,
          });
          // fall through to the direct-HTTP fallback below
        } else {
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
      } else {
        log.warn('Tunnel request failed', {
          namespace: 'proxy',
          runnerId,
          error: (tunnelErr as Error).message,
        });
      }
    }
  }

  // Runner not connected via Socket.IO — try direct HTTP if available
  if (httpUrl) {
    try {
      return await directHttpFetch(
        c,
        httpUrl,
        path,
        url.search,
        withFreshSignature(),
        body,
        deps.directFetch,
      );
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

function isLoopbackRunnerUrl(rawUrl: string): boolean {
  try {
    const { hostname } = new URL(rawUrl);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    );
  } catch {
    return false;
  }
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
  fetchImpl: FetchLike,
): Promise<Response> {
  const targetUrl = `${httpUrl}${path}${search}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(forwardedHeaders)) {
    headers.set(key, value);
  }

  const runnerResponse = await fetchImpl(targetUrl, {
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
  // Range/partial-content headers — payload-describing and safe (no security
  // surface like Set-Cookie / CORS). Required so a runner's 206 reaches the
  // browser intact for <video>/<audio> seek; see the Range forwarding above.
  'accept-ranges',
  'content-range',
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
