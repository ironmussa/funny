/**
 * LLM credential proxy (change thread-sandboxes).
 *
 *   ANY /api/llm-proxy/anthropic/v1/* — Anthropic, with the owner's credential
 *
 * Mounted before the session middleware: callers are sandbox agents that
 * authenticate with their sandbox's proxy token (`Authorization: Bearer` or
 * `x-api-key`), never with a session. The token is swapped for the sandbox
 * owner's stored credential, so the real credential never leaves the server.
 */

import { Hono } from 'hono';
import type { ResultAsync } from 'neverthrow';

import { log } from '../lib/logger.js';
import { metric } from '../lib/telemetry.js';
import {
  ANTHROPIC_CREDENTIAL_KEY_ID,
  ANTHROPIC_UPSTREAM,
  anthropicUpstreamHeaders,
  isAllowedAnthropicPath,
  proxiedResponseHeaders,
} from '../services/llm-proxy/anthropic-adapter.js';
import {
  resolveLlmProxyToken,
  type LlmProxyGrant,
} from '../services/llm-proxy/llm-proxy-tokens.js';
import { getProviderKey } from '../services/profile-service.js';

export interface LlmProxyDeps {
  resolveToken(token: string): ResultAsync<LlmProxyGrant | null, string>;
  /** The owner's credential for a provider key id, or null when not configured. */
  credentialFor(userId: string, keyId: string): Promise<string | null>;
  fetch?: typeof fetch;
  upstream?: string;
}

/** Anthropic-shaped error body, so Claude Code shows the message to the user. */
function anthropicError(status: number, type: string, message: string) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function presentedToken(headers: Headers): string | null {
  const bearer = headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer?.trim() || headers.get('x-api-key')?.trim() || null;
}

type RecordOutcome = (result: string) => void;

/** The sandbox grant behind the presented proxy token, or the error Response to return. */
async function authenticateGrant(
  deps: LlmProxyDeps,
  headers: Headers,
  outcome: RecordOutcome,
): Promise<LlmProxyGrant | Response> {
  const token = presentedToken(headers);
  const resolved = token ? await deps.resolveToken(token) : null;
  if (resolved?.isErr()) {
    log.error('LLM proxy token lookup failed', { namespace: 'llm-proxy', error: resolved.error });
    outcome('error');
    return anthropicError(500, 'api_error', 'funny LLM proxy unavailable');
  }
  const grant = resolved?.isOk() ? resolved.value : null;
  if (!grant) {
    outcome('unauthorized');
    return anthropicError(401, 'authentication_error', 'Invalid or revoked sandbox token');
  }
  return grant;
}

interface UpstreamCall {
  doFetch: typeof fetch;
  target: string;
  method: string;
  raw: Request;
  credential: string;
  grant: LlmProxyGrant;
  outcome: RecordOutcome;
}

/** Forward the request to Anthropic with the owner's credential and relay the answer. */
async function forwardUpstream(call: UpstreamCall): Promise<Response> {
  const { doFetch, target, method, raw, credential, outcome } = call;
  const { userId, threadId } = call.grant;
  const hasBody = method !== 'GET' && method !== 'HEAD';
  let response: Response;
  try {
    response = await doFetch(target, {
      method,
      headers: anthropicUpstreamHeaders(raw.headers, credential),
      ...(hasBody ? { body: raw.body, duplex: 'half' } : {}),
      signal: raw.signal,
    } as RequestInit);
  } catch (error) {
    log.warn('LLM proxy upstream request failed', {
      namespace: 'llm-proxy',
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    outcome('upstream-error');
    return anthropicError(502, 'api_error', 'Could not reach Anthropic');
  }
  if (response.status === 401 || response.status === 403) {
    log.warn('Anthropic rejected the stored credential', {
      namespace: 'llm-proxy',
      threadId,
      userId,
      status: response.status,
    });
  }
  outcome(String(response.status));
  return new Response(response.body, {
    status: response.status,
    headers: proxiedResponseHeaders(response.headers),
  });
}

export function createLlmProxyRoutes(deps: LlmProxyDeps) {
  const doFetch = deps.fetch ?? fetch;
  const upstream = deps.upstream ?? ANTHROPIC_UPSTREAM;
  const routes = new Hono();

  routes.all('/anthropic/*', async (c) => {
    const url = new URL(c.req.url);
    // Everything after the first `/anthropic` segment, wherever the routes are mounted.
    const path = url.pathname.replace(/^.*?\/anthropic(?=\/)/, '');
    const outcome = (result: string) =>
      metric('llm_proxy.requests', 1, { attributes: { provider: 'anthropic', result } });

    const grant = await authenticateGrant(deps, c.req.raw.headers, outcome);
    if (grant instanceof Response) return grant;
    if (!isAllowedAnthropicPath(path)) {
      log.warn('LLM proxy refused path', { namespace: 'llm-proxy', path, method: c.req.method });
      outcome('forbidden');
      return anthropicError(403, 'permission_error', `Path not allowed through funny: ${path}`);
    }

    const credential = await deps.credentialFor(grant.userId, ANTHROPIC_CREDENTIAL_KEY_ID);
    if (!credential) {
      outcome('no-credential');
      return anthropicError(
        401,
        'authentication_error',
        'No Claude credential for sandboxes: run `claude setup-token` and paste it in Preferences > AI Providers.',
      );
    }

    return forwardUpstream({
      doFetch,
      target: `${upstream}${path}${url.search}`,
      method: c.req.method,
      raw: c.req.raw,
      credential,
      grant,
      outcome,
    });
  });

  return routes;
}

export function llmProxyRoutes() {
  return createLlmProxyRoutes({
    resolveToken: resolveLlmProxyToken,
    credentialFor: getProviderKey,
  });
}
