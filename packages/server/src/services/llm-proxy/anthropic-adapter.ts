/**
 * Anthropic adapter for the LLM credential proxy (change thread-sandboxes).
 *
 * Claude Code in a sandbox runs with `ANTHROPIC_BASE_URL` pointing at the
 * proxy and `ANTHROPIC_AUTH_TOKEN` set to the sandbox's proxy token. This
 * module decides which upstream paths may be reached and rewrites the headers:
 * the sandbox's credential is dropped and the owner's real one is added — a
 * subscription token (`claude setup-token`, sent as an OAuth bearer with the
 * OAuth beta) or an API key (`x-api-key`).
 */

export const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';
export const ANTHROPIC_CREDENTIAL_KEY_ID = 'claude-subscription';

const OAUTH_BETA = 'oauth-2025-04-20';

/** Model endpoints only: messages, token counting and the model list. */
const ALLOWED_PATH = /^\/v1\/(messages(\/count_tokens)?|models(\/[A-Za-z0-9._-]+)?)$/;

/** Headers never forwarded upstream: credentials, cookies and hop-by-hop. */
const DROPPED_REQUEST_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'accept-encoding',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
]);

/** Response headers that would be wrong after the proxy re-streams the body. */
const DROPPED_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'set-cookie',
]);

export function isAllowedAnthropicPath(path: string): boolean {
  return ALLOWED_PATH.test(path);
}

/** OAuth tokens from `claude setup-token`; anything else is treated as an API key. */
function isOAuthToken(credential: string): boolean {
  return credential.startsWith('sk-ant-oat');
}

export function anthropicUpstreamHeaders(incoming: Headers, credential: string): Headers {
  const out = new Headers();
  incoming.forEach((value, key) => {
    if (!DROPPED_REQUEST_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  // Plain bodies, so the stream can be passed through untouched.
  out.set('accept-encoding', 'identity');
  if (isOAuthToken(credential)) {
    out.set('authorization', `Bearer ${credential}`);
    const betas = (out.get('anthropic-beta') ?? '')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);
    if (!betas.includes(OAUTH_BETA)) betas.push(OAUTH_BETA);
    out.set('anthropic-beta', betas.join(','));
  } else {
    out.set('x-api-key', credential);
  }
  return out;
}

export function proxiedResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value, key) => {
    if (!DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}
