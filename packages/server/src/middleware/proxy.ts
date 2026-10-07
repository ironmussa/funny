/**
 * HTTP reverse proxy middleware for the central server.
 *
 * Any /api/* route not handled by native server routes gets forwarded
 * to the appropriate runner through its runner-initiated gRPC tunnel.
 *
 * STRICT ISOLATION (runner-request-isolation): the runner is selected AND
 * certified for the requesting user by `services/runner-access`
 * (`withRunnerFor`), and the request is sent through the authorized sink,
 * which signs the forwarded identity itself from the certified actor. If no
 * runner of the user is reachable, we return 502 immediately.
 *
 * Headers added to proxied requests (by the authorized sink):
 * - X-Forwarded-User / -Role / -Org / -Org-Name: the authenticated identity
 * - X-Runner-Auth: shared secret so the runner trusts the server
 * - X-Forwarded-Signature / X-Forwarded-Timestamp / X-Forwarded-Nonce:
 *   HMAC-SHA256 over the forwarded identity, proving the sender HOLDS the
 *   shared secret (so a caller WITHOUT it — e.g. a browser hitting a runner
 *   directly — cannot forge the headers). It does not distinguish the server
 *   from a runner that holds the same secret; see the trust-boundary note in
 *   `@funny/shared/auth/forwarded-identity`.
 */

import type { Context } from 'hono';

import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import {
  authorizedRunnerRequests,
  runnerAccess,
  runnerActor,
  type AuthorizedRunnerRequests,
  type RunnerAccess,
  type UnsignedRunnerRequest,
} from '../services/runner-access/index.js';
import {
  RunnerRequestTimeoutError,
  type RunnerPresencePort,
  type RunnerRequestPort,
  type RunnerResponse,
} from '../services/runner-ports.js';
import { describeResolutionFailure } from '../services/runner-resolver.js';

/**
 * Transport dependencies the proxy uses to reach a runner. Injectable so tests
 * can supply deterministic fakes directly, without Bun's process-global
 * `mock.module` (which leaks across test files and makes the tunnel-timeout
 * assertions flaky). Production uses `defaultTransport`: the real runner
 * access (resolvers + certification) and the per-request Hono bindings.
 */
export interface ProxyTransport {
  /** Runner selection + certification. Default: `services/runner-access`. */
  runnerAccess?: RunnerAccess;
  requests?: RunnerRequestPort;
  presence?: RunnerPresencePort;
}

const defaultTransport: ProxyTransport = {};

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
 */
async function proxyToRunnerImpl(c: Context<ServerEnv>, deps: ProxyTransport): Promise<Response> {
  const userId = c.get('userId') as string | undefined;

  const url = new URL(c.req.url);
  const path = url.pathname;

  // MCP OAuth callback: the external provider redirects the browser here without
  // any session cookie. The runtime validates the state parameter to ensure only
  // the correct flow is completed. Resolve any connected general runner (no user
  // scoping) through the identity-free `OAuthCallbackRunner` proof.
  const isOAuthCallback = path === '/api/mcp/oauth/callback';

  if (!userId && !isOAuthCallback) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const access = deps.runnerAccess ?? runnerAccess;
  const presence = deps.presence ?? c.env?.runnerPresence;
  const sink = authorizedRunnerRequests(deps.requests ?? c.env?.runnerRequests);
  const query = Object.fromEntries(url.searchParams.entries());

  // Non-identity headers forwarded to the runner. Identity headers are set by
  // the authorized sink and anything the client sent for them is dropped.
  const forwardedHeaders: Record<string, string> = {
    'content-type': c.req.header('content-type') || 'application/json',
  };

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

  // Read body for non-GET/HEAD requests
  let bodyBytes: Uint8Array | null = null;
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    try {
      bodyBytes = new Uint8Array(await c.req.arrayBuffer());
    } catch {
      bodyBytes = null;
    }
  }
  const request: UnsignedRunnerRequest = {
    method: c.req.method,
    path: `${path}${url.search}`,
    headers: forwardedHeaders,
    body: bodyBytes,
    signal: c.req.raw.signal,
  };

  /** One physical tunnel send, mapped to the proxy's HTTP outcomes. */
  const relay = async (
    send: () => Promise<RunnerResponse>,
    runnerId: string,
  ): Promise<Response> => {
    try {
      const tunnelResp = await send();

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
  };

  const notConnected = () =>
    c.json({ error: 'No runner connected. Check that your runner is online.' }, 502);

  if (isOAuthCallback) {
    const sent = await access.withOAuthCallbackRunner(presence, async (runner, proof) =>
      sink.isAvailable(runner)
        ? relay(() => sink.sendOAuthCallback(runner, proof, request), runner.value)
        : notConnected(),
    );
    if (sent.isErr()) {
      log.warn('No reachable runner for proxy request', { namespace: 'proxy', userId, path });
      return c.json(describeResolutionFailure('general-runner-offline'), 502);
    }
    return sent.value;
  }

  const requester = runnerActor({
    userId: userId!,
    role: c.get('userRole') as string | undefined,
    orgId: c.get('organizationId') as string | undefined,
    orgName: c.get('organizationName') as string | undefined,
  });

  // ── Steer-share delegation (thread-sharing-steer) ──────────────────────
  // The runner-isolation invariant routes a request ONLY to the requester's
  // own runner. The single intentional exception: when an ALLOW-LISTED route
  // (`POST /:id/message`, read-only git GETs) has already authorized a `steer`
  // sharee, the upstream middleware (`requireThreadSteer`) loaded the thread
  // into context. The thread lives on its OWNER's runner, so we certify a
  // runner for the OWNER (`RunnerFor<Owner, R>`) — never a blind fallback —
  // and send through `sendDelegated`, which signs the SHAREE with a `steer`
  // claim for the thread (the runtime has no DB to look up the grant). Routes
  // NOT guarded by a thread-access middleware never set `thread`, so they can
  // never trigger this path. See CLAUDE.md "Runner Isolation (CRITICAL)".
  const thread = c.get('thread') as ServerEnv['Variables']['thread'] | undefined;
  const delegation =
    thread && thread.userId && thread.userId !== userId
      ? { ownerId: thread.userId, threadId: thread.id }
      : null;
  if (delegation) {
    audit({
      action: 'share.steer_delegation',
      actorId: userId!,
      detail: `sharee routed to owner runner for ${c.req.method} ${path}`,
      meta: {
        threadId: delegation.threadId,
        ownerId: delegation.ownerId,
        method: c.req.method,
        path,
      },
    });
  }

  const sent = await access.withRunnerFor(
    delegation ? runnerActor({ userId: delegation.ownerId }) : requester,
    { kind: 'request', path, query },
    presence,
    async (actor, runner, proof) => {
      if (!sink.isAvailable(runner)) return notConnected();
      return relay(
        () =>
          delegation
            ? sink.sendDelegated(
                actor,
                runner,
                proof,
                { sharee: requester, threadId: delegation.threadId },
                request,
              )
            : sink.send(actor, runner, proof, request),
        runner.value,
      );
    },
  );
  if (sent.isErr()) {
    log.warn('No reachable runner for proxy request', { namespace: 'proxy', userId, path });
    return c.json(describeResolutionFailure(sent.error.reason), 502);
  }
  return sent.value;
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

export type { AuthorizedRunnerRequests };
