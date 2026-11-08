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

import { parseStoredJson } from '@funny/shared/json-validation';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import { renderMcpOAuthCallbackPage } from '../lib/mcp-oauth-callback-page.js';
import { neutralizeRunnerContent } from '../lib/runner-content-policy.js';
import type { ServerEnv } from '../lib/types.js';
import {
  authorizedRunnerRequests,
  mintOAuthCallbackState,
  OAUTH_STATE_HEADER,
  runnerAccess,
  runnerActor,
  type RunnerAccess,
  type RunnerActor,
  type UnsignedRunnerRequest,
} from '../services/runner-access/index.js';
import {
  RunnerRequestTimeoutError,
  type RunnerPresencePort,
  type RunnerRequestPort,
  type RunnerResponse,
} from '../services/runner-ports.js';
import { describeResolutionFailure, extractThreadId } from '../services/runner-resolver.js';
import { sandboxWaker, type SandboxWaker } from '../services/thread-sandboxes/sandbox-lifecycle.js';

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
  /** Wakes a stopped thread sandbox. Default: the server's sandbox lifecycle. */
  sandboxWaker?: SandboxWaker | null;
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

type ProxySink = ReturnType<typeof authorizedRunnerRequests>;

/** Steer-share delegation target: the thread OWNER whose runner serves the sharee. */
interface Delegation {
  ownerId: string;
  threadId: string;
}

/** Everything one certified send needs; built once per proxied request. */
interface ProxySendContext {
  c: Context<ServerEnv>;
  path: string;
  query: Record<string, string>;
  access: RunnerAccess;
  presence: RunnerPresencePort | undefined;
  sink: ProxySink;
  request: UnsignedRunnerRequest;
  requester: RunnerActor;
  delegation: Delegation | null;
  isOAuthStart: boolean;
}

/**
 * Non-identity headers forwarded to the runner. Identity headers are set by
 * the authorized sink and anything the client sent for them is dropped.
 */
function buildForwardedHeaders(c: Context<ServerEnv>, url: URL): Record<string, string> {
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
  return forwardedHeaders;
}

/** Read body for non-GET/HEAD requests. */
async function readRequestBody(c: Context<ServerEnv>): Promise<Uint8Array | null> {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return null;
  try {
    return new Uint8Array(await c.req.arrayBuffer());
  } catch {
    return null;
  }
}

function isTunnelTimeout(tunnelErr: unknown): boolean {
  return (
    tunnelErr instanceof RunnerRequestTimeoutError ||
    (typeof tunnelErr === 'object' &&
      tunnelErr !== null &&
      (tunnelErr as Error).name === 'TunnelTimeoutError')
  );
}

/** Map a tunnel response onto an HTTP Response for the browser. */
function toBrowserResponse(tunnelResp: RunnerResponse): Response {
  // Relayed requests stream the runner's bytes straight through (no full
  // buffer, no base64 round trip). Otherwise a binary response (image, video,
  // PDF…) arrives base64-encoded so its bytes survive the JSON ack — decode it
  // back to raw bytes here — and a text response is passed through verbatim.
  const tunnelBody =
    tunnelResp.bodyStream ??
    (tunnelResp.bodyEncoding === 'base64' && tunnelResp.body != null
      ? Buffer.from(tunnelResp.body, 'base64')
      : tunnelResp.body);

  // Security M5: filter runner response headers on the tunnel path too —
  // Leaving it unfiltered would let a malicious runner
  // set `Set-Cookie` / `Access-Control-*` / security-policy headers on the
  // central server's origin for the requesting user's browser.
  return new Response(tunnelBody, {
    status: tunnelResp.status,
    headers: neutralizeRunnerContent(
      filterSafeRunnerResponseHeaders(new Headers(tunnelResp.headers)),
    ),
  });
}

/** One physical tunnel send, mapped to the proxy's HTTP outcomes. */
async function relay(
  c: Context<ServerEnv>,
  path: string,
  send: () => Promise<RunnerResponse>,
  runnerId: string,
): Promise<Response> {
  try {
    return toBrowserResponse(await send());
  } catch (tunnelErr) {
    if (isTunnelTimeout(tunnelErr)) {
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
function resolveDelegation(c: Context<ServerEnv>, userId: string, path: string): Delegation | null {
  const thread = c.get('thread') as ServerEnv['Variables']['thread'] | undefined;
  const delegation =
    thread && thread.userId && thread.userId !== userId
      ? { ownerId: thread.userId, threadId: thread.id }
      : null;
  if (delegation) {
    audit({
      action: 'share.steer_delegation',
      actorId: userId,
      detail: `sharee routed to owner runner for ${c.req.method} ${path}`,
      meta: {
        threadId: delegation.threadId,
        ownerId: delegation.ownerId,
        method: c.req.method,
        path,
      },
    });
  }
  return delegation;
}

/**
 * Certify a runner (for the requester, or for the thread OWNER on a steer
 * delegation) and send through the authorized sink. The proof never leaves
 * the `withRunnerFor` callback.
 */
function sendViaCertifiedRunner(ctx: ProxySendContext) {
  const { c, path, query, access, presence, sink, request, requester, delegation } = ctx;
  return access.withRunnerFor(
    delegation ? runnerActor({ userId: delegation.ownerId }) : requester,
    { kind: 'request', path, query },
    presence,
    async (actor, runner, proof) => {
      if (!sink.isAvailable(runner)) {
        return c.json({ error: 'No runner connected. Check that your runner is online.' }, 502);
      }
      // Bind the OAuth flow this runner is about to start to (user, runner):
      // the provider echoes the state back to the unauthenticated callback,
      // which is then routed to this runner only. Never for a delegated send.
      const outgoing: UnsignedRunnerRequest =
        ctx.isOAuthStart && !delegation
          ? {
              ...request,
              headers: {
                ...request.headers,
                [OAUTH_STATE_HEADER]: mintOAuthCallbackState(actor, runner, proof),
              },
            }
          : request;
      return relay(
        c,
        path,
        () =>
          delegation
            ? sink.sendDelegated(
                actor,
                runner,
                proof,
                { sharee: requester, threadId: delegation.threadId },
                outgoing,
              )
            : sink.send(actor, runner, proof, outgoing),
        runner.value,
      );
    },
  );
}

type ProxySendResult = Awaited<ReturnType<typeof sendViaCertifiedRunner>>;

/** A stopped sandbox is woken for its owner (bounded), then the request retried once. */
async function retryAfterSandboxWake(
  ctx: ProxySendContext,
  deps: ProxyTransport,
  userId: string,
  sent: ProxySendResult,
): Promise<ProxySendResult> {
  const waker = deps.sandboxWaker === undefined ? sandboxWaker() : deps.sandboxWaker;
  const sandboxThreadId = extractThreadId(ctx.path);
  if (
    sent.isErr() &&
    sent.error.reason === 'thread-sandbox-unavailable' &&
    waker &&
    sandboxThreadId
  ) {
    const woken = await waker.wake(sandboxThreadId, ctx.delegation?.ownerId ?? userId);
    if (woken.isOk()) return sendViaCertifiedRunner(ctx);
  }
  return sent;
}

/**
 * Hono handler that proxies the request to the appropriate runner.
 */
async function proxyToRunnerImpl(c: Context<ServerEnv>, deps: ProxyTransport): Promise<Response> {
  const userId = c.get('userId') as string | undefined;

  const url = new URL(c.req.url);
  const path = url.pathname;

  // MCP OAuth callback: the external provider redirects the browser here without
  // any session cookie. It is routed ONLY to the runner its server-signed
  // `state` is bound to (minted below when this server proxied `/oauth/start`),
  // through the identity-free `OAuthCallbackRunner` proof. The page is rendered
  // here — runner HTML is never relayed on this origin.
  const isOAuthCallback = path === '/api/mcp/oauth/callback';

  if (!userId && !isOAuthCallback) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { access, presence, sink } = resolveTransport(c, deps);
  const query = Object.fromEntries(url.searchParams.entries());
  const request: UnsignedRunnerRequest = {
    method: c.req.method,
    path: `${path}${url.search}`,
    headers: buildForwardedHeaders(c, url),
    body: await readRequestBody(c),
    signal: c.req.raw.signal,
  };

  // The OAuth callback parses the runner's body, so it keeps the buffered path.
  if (isOAuthCallback) return handleOAuthCallback(c, url, access, presence, sink, request);
  request.streamBody = true;

  const requester = runnerActor({
    userId: userId!,
    role: c.get('userRole') as string | undefined,
    orgId: c.get('organizationId') as string | undefined,
    orgName: c.get('organizationName') as string | undefined,
  });

  const ctx: ProxySendContext = {
    c,
    path,
    query,
    access,
    presence,
    sink,
    request,
    requester,
    delegation: resolveDelegation(c, userId!, path),
    isOAuthStart: c.req.method === 'POST' && path === '/api/mcp/oauth/start',
  };

  const sent = await retryAfterSandboxWake(ctx, deps, userId!, await sendViaCertifiedRunner(ctx));
  if (sent.isErr()) {
    log.warn('No reachable runner for proxy request', { namespace: 'proxy', userId, path });
    return c.json(describeResolutionFailure(sent.error.reason), 502);
  }
  return sent.value;
}

function resolveTransport(c: Context<ServerEnv>, deps: ProxyTransport) {
  return {
    access: deps.runnerAccess ?? runnerAccess,
    presence: deps.presence ?? c.env?.runnerPresence,
    sink: authorizedRunnerRequests(deps.requests ?? c.env?.runnerRequests),
  };
}

type OAuthCallbackSink = ProxySink;

function oauthCallbackPage(
  c: Context<ServerEnv>,
  success: boolean,
  error: string,
  status: ContentfulStatusCode = 200,
) {
  return c.html(renderMcpOAuthCallbackPage(success, error), status);
}

/**
 * Unauthenticated MCP OAuth callback (H3 / M3). The state's binding decides
 * the ONE runner that may receive the provider's `code`; an invalid, forged or
 * expired state reaches no runner at all. The runner answers with a JSON
 * result and this server renders the page — runner bytes are never served.
 */
async function handleOAuthCallback(
  c: Context<ServerEnv>,
  url: URL,
  access: RunnerAccess,
  presence: RunnerPresencePort | undefined,
  sink: OAuthCallbackSink,
  request: UnsignedRunnerRequest,
): Promise<Response> {
  const state = url.searchParams.get('state') ?? undefined;
  const providerError = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const sent = await access.withOAuthCallbackRunner(state, presence, async (runner, proof) => {
    // The provider reported a failure: nothing to exchange, show it.
    if (providerError) {
      return oauthCallbackPage(
        c,
        false,
        url.searchParams.get('error_description') || providerError,
      );
    }
    if (!code) return oauthCallbackPage(c, false, 'Missing code or state parameter', 400);
    if (!sink.isAvailable(runner)) {
      return oauthCallbackPage(c, false, 'Your runner is not connected', 502);
    }
    try {
      const resp = await sink.sendOAuthCallback(runner, proof, {
        ...request,
        headers: { ...request.headers, accept: 'application/json' },
      });
      const result = parseOAuthCallbackResult(resp.bodyEncoding === 'base64' ? null : resp.body);
      if (!result) return oauthCallbackPage(c, false, 'Unexpected response from runner', 502);
      return oauthCallbackPage(c, result.success, result.error ?? '');
    } catch (e) {
      log.warn('MCP OAuth callback tunnel failed', {
        namespace: 'proxy',
        runnerId: runner.value,
        error: (e as Error).message,
      });
      return oauthCallbackPage(c, false, 'Runner did not respond', 502);
    }
  });
  if (sent.isOk()) return sent.value;
  if (sent.error.kind === 'oauth-state-invalid') {
    return oauthCallbackPage(c, false, 'Invalid or expired state parameter', 400);
  }
  log.warn('No reachable runner for MCP OAuth callback', { namespace: 'proxy' });
  return oauthCallbackPage(c, false, 'Your runner is not connected', 502);
}

const oauthCallbackResultSchema = z.object({
  success: z.boolean(),
  error: z.string().nullish(),
});

function parseOAuthCallbackResult(
  body: string | null | undefined,
): { success: boolean; error?: string | null } | null {
  if (!body) return null;
  const parsed = parseStoredJson(oauthCallbackResultSchema, body, 'runner OAuth callback result');
  return parsed.ok ? parsed.value : null;
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
