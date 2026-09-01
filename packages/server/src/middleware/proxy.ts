/**
 * HTTP reverse proxy middleware for the central server.
 *
 * Any /api/* route not handled by native server routes gets forwarded
 * to the appropriate runner through its runner-initiated gRPC tunnel.
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
import {
  RunnerRequestTimeoutError,
  type RunnerPresencePort,
  type RunnerRequestPort,
} from '../services/runner-ports.js';
import * as runnerResolver from '../services/runner-resolver.js';

/**
 * Transport dependencies the proxy uses to reach a runner. Injectable so tests
 * can supply deterministic fakes directly, without Bun's process-global
 * `mock.module` (which leaks across test files and makes the tunnel-timeout
 * assertions flaky). Production uses `defaultTransport`, whose members delegate
 * to the real service singletons at call time.
 */
export interface ProxyTransport {
  resolveRunner: typeof runnerResolver.resolveRunner;
  resolveAnyRunner: typeof runnerResolver.resolveAnyRunner;
  requests?: RunnerRequestPort;
  presence?: RunnerPresencePort;
}

const defaultTransport: ProxyTransport = {
  resolveRunner: (...args) => runnerResolver.resolveRunner(...args),
  resolveAnyRunner: (...args) => runnerResolver.resolveAnyRunner(...args),
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
  const presence = deps.presence ?? c.env?.runnerPresence;
  const resolved = isOAuthCallback
    ? await deps.resolveAnyRunner(presence)
    : await deps.resolveRunner(path, query, resolveUserId, presence);

  if (!resolved) {
    log.warn('No reachable runner for proxy request', {
      namespace: 'proxy',
      userId,
      path,
    });
    return c.json({ error: 'No runner connected. Check that your runner is online.' }, 502);
  }

  const { runnerId } = resolved;
  const requests = deps.requests ?? c.env?.runnerRequests;
  if (!requests?.isAvailable(runnerId)) {
    return c.json({ error: 'No runner connected. Check that your runner is online.' }, 502);
  }

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
  // The signature carries a single-use nonce that the runtime records in a
  // replay cache once the HMAC verifies. Mint it immediately before the one
  // physical gRPC tunnel send.
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
  let bodyBytes: Uint8Array | null = null;
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    try {
      bodyBytes = new Uint8Array(await c.req.arrayBuffer());
    } catch {
      bodyBytes = null;
    }
  }
  const tunnelPath = `${path}${url.search}`;
  try {
    const tunnelResp = await requests.request(runnerId, {
      method: c.req.method,
      path: tunnelPath,
      headers: withFreshSignature(),
      body: bodyBytes,
      signal: c.req.raw.signal,
    });

    // A binary response (image, video, PDF…) arrives base64-encoded so its
    // bytes survive the JSON ack — decode it back to raw bytes here. A text
    // response (the common JSON API payload) is passed through verbatim.
    const tunnelBody =
      tunnelResp.bodyEncoding === 'base64' && tunnelResp.body != null
        ? Buffer.from(tunnelResp.body, 'base64')
        : tunnelResp.body;

    // Security M5: filter runner response headers on the tunnel path too —
    // Leaving it unfiltered would let a malicious runner
    // set `Set-Cookie` / `Access-Control-*` / security-policy headers on the
    // central server's origin for the requesting user's browser.
    return new Response(tunnelBody, {
      status: tunnelResp.status,
      headers: filterSafeRunnerResponseHeaders(new Headers(tunnelResp.headers)),
    });
  } catch (tunnelErr) {
    if (
      tunnelErr instanceof RunnerRequestTimeoutError ||
      (typeof tunnelErr === 'object' &&
        tunnelErr !== null &&
        (tunnelErr as Error).name === 'TunnelTimeoutError')
    ) {
      log.warn('gRPC tunnel request timed out', {
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
    log.warn('gRPC tunnel request failed', {
      namespace: 'proxy',
      runnerId,
      error: (tunnelErr as Error).message,
    });
    return c.json({ error: 'Runner tunnel unavailable.' }, 502);
  }
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
