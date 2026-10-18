/**
 * @domain subdomain: Authentication
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Runtime auth middleware.
 *
 * The runtime always runs as a remote runner connected to the central server.
 * Auth priority:
 * 1. **X-Runner-Auth + signed identity** — THIS runner's own forwarding key
 *    `K_r` (security H1, see `../lib/runner-keys.ts`) from the server proxy
 *    plus an HMAC (keyed with `K_r`) over
 *    `userId|role|orgId|orgName|timestamp|nonce` in the
 *    `X-Forwarded-Signature` / `X-Forwarded-Timestamp` / `X-Forwarded-Nonce`
 *    headers. Only the server (which holds the root secret) and this runner
 *    know `K_r`; another runner's key does not verify here. The per-request
 *    nonce makes every signature unique so parallel requests in the same
 *    millisecond don't false-trip the replay cache. No key yet (not
 *    registered) ⇒ fail closed.
 * 2. **Server session** — browser cookie validated against TEAM_SERVER_URL,
 *    accepted ONLY for this runner's owner (security H7). Any other server
 *    user — and any user at all while the owner is unknown — is refused; a
 *    steer-share sharee reaches the owner's runner exclusively through the
 *    server's signed delegation (path 1).
 *
 * Anything else is 401. The runner has no auth database of its own, so there
 * is no local session fallback.
 */

import { timingSafeEqual } from 'crypto';

import {
  NONCE_HEADER,
  ON_BEHALF_OF_THREAD_HEADER,
  SHARE_LEVEL_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import type { Context, Next } from 'hono';

import { log } from '../lib/logger.js';
import { getRunnerForwardingKey, getRunnerOwnerUserId } from '../lib/runner-keys.js';

/** Paths that skip authentication entirely */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/mode',
  '/api/bootstrap',
  '/api/mcp/oauth/callback',
  // Transport C: a cross-origin <img>/<video> request from the browser carries
  // neither a session cookie nor the shared-secret header. It authenticates with
  // the HMAC-signed query params instead, verified inside the route handler.
  '/api/files/raw-signed',
]);

const TEAM_SERVER_URL = process.env.TEAM_SERVER_URL;
const WS_TUNNEL_ONLY = process.env.WS_TUNNEL_ONLY === 'true' || process.env.WS_TUNNEL_ONLY === '1';

// Cache validated sessions: cookie hash → { userId, role, orgId, expiresAt }
const sessionCache = new Map<string, SessionEntry>();
const SESSION_CACHE_TTL = 15_000; // 15 seconds — balance between performance and session revocation freshness

/**
 * Security ME-7: cache lookups are only honoured for read-only methods
 * (GET / HEAD / OPTIONS). A user who logged out continues to see cached
 * authorization for read traffic for up to `SESSION_CACHE_TTL`, but any
 * mutating verb forces a fresh `/api/auth/get-session` round-trip so a
 * stale session can't perform destructive writes during the cache window.
 */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Runtime auth middleware — see the module comment for the accepted credentials. */
export async function authMiddleware(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;

  if (PUBLIC_PATHS.has(path)) return next();

  // ── Forwarded auth from server via this runner's forwarding key ──
  const forwardingKey = getRunnerForwardingKey();
  if (forwardingKey && runnerAuthMatches(c.req.header('X-Runner-Auth'), forwardingKey)) {
    return forwardedAuth(c, next, forwardingKey);
  }

  // ── Server session validation (when connected to a central server) ──
  // Skip in WS-only mode — all requests arrive via tunnel with X-Runner-Auth already set
  const cookie = c.req.header('Cookie');
  if (TEAM_SERVER_URL && !WS_TUNNEL_ONLY && cookie) return cookieAuth(c, next, cookie);

  return c.json({ error: 'Unauthorized' }, 401);
}

/** Constant-time `X-Runner-Auth` comparison against this runner's K_r. */
function runnerAuthMatches(header: string | undefined, forwardingKey: string): boolean {
  return (
    !!header &&
    header.length === forwardingKey.length &&
    timingSafeEqual(Buffer.from(header), Buffer.from(forwardingKey))
  );
}

/**
 * `X-Runner-Auth` proves the request went through the server proxy path; the
 * HMAC signature proves the forwarded identity headers were set by the server
 * (not spoofed). Both are keyed with THIS runner's K_r.
 */
async function forwardedAuth(c: Context, next: Next, forwardingKey: string) {
  const userId = c.req.header('X-Forwarded-User');
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  const role = c.req.header('X-Forwarded-Role') || 'user';
  const orgId = c.req.header('X-Forwarded-Org') || null;
  const orgName = c.req.header('X-Forwarded-Org-Name') || null;
  // Steer-share delegation claim (thread-sharing-steer). Part of the signed
  // payload, so it cannot be forged by a caller without the key.
  const shareLevel = c.req.header(SHARE_LEVEL_HEADER) || null;
  const onBehalfOfThread = c.req.header(ON_BEHALF_OF_THREAD_HEADER) || null;

  const signature = c.req.header(SIGNATURE_HEADER);
  const timestamp = c.req.header(TIMESTAMP_HEADER);
  const nonce = c.req.header(NONCE_HEADER);
  const valid = verifyForwardedIdentity(
    { userId, role, orgId, orgName, shareLevel, onBehalfOfThread },
    forwardingKey,
    signature,
    timestamp,
    nonce,
  );
  if (!valid) {
    log.warn('Rejected forwarded identity with invalid signature', {
      namespace: 'auth',
      hasSignature: !!signature,
      hasTimestamp: !!timestamp,
      hasNonce: !!nonce,
    });
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('userId', userId);
  c.set('userRole', role);
  c.set('organizationId', orgId);
  c.set('organizationName', orgName);
  c.set('shareLevel', shareLevel);
  c.set('onBehalfOfThread', onBehalfOfThread);
  return next();
}

type SessionEntry = { userId: string; role: string; orgId: string | null; expiresAt: number };

/**
 * Session cookie validated against the central server. Security H7: only this
 * runner's owner may authenticate this way; fail closed while the owner is
 * unknown (not registered yet, or legacy stored credentials).
 */
async function cookieAuth(c: Context, next: Next, cookie: string) {
  const ownerUserId = getRunnerOwnerUserId();
  if (!ownerUserId) {
    log.warn('Rejected cookie auth: runner owner is unknown', { namespace: 'auth' });
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const cacheKey = new Bun.CryptoHasher('sha256').update(cookie).digest('hex');

  // Security ME-7: read traffic may use the cache; mutating verbs must
  // re-validate so a stale (post-logout / post-revoke) session can't be
  // used to perform destructive writes during the cache window.
  const cached = sessionCache.get(cacheKey);
  const useCache = cached && cached.expiresAt > Date.now() && READ_ONLY_METHODS.has(c.req.method);
  const entry = useCache ? cached : await validateSession(cookie, cacheKey);
  if (!entry) return c.json({ error: 'Unauthorized' }, 401);
  if (entry.userId !== ownerUserId) return rejectNonOwner(c, entry.userId);

  c.set('userId', entry.userId);
  c.set('userRole', entry.role);
  c.set('organizationId', entry.orgId);
  c.set('organizationName', null);
  return next();
}

/** Ask the central server who owns `cookie`; caches the result. Null if invalid. */
async function validateSession(cookie: string, cacheKey: string): Promise<SessionEntry | null> {
  try {
    const forwardCookie = cookie.replace(/\bbetter-auth\./g, '__Secure-better-auth.');
    const res = await fetch(`${TEAM_SERVER_URL}/api/auth/get-session`, {
      headers: { Cookie: forwardCookie },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (!data?.user?.id) return null;
    const entry: SessionEntry = {
      userId: data.user.id as string,
      role: (data.user.role as string) || 'user',
      orgId: (data.session?.activeOrganizationId as string) ?? null,
      expiresAt: Date.now() + SESSION_CACHE_TTL,
    };
    sessionCache.set(cacheKey, entry);
    return entry;
  } catch (err) {
    log.warn('Failed to validate session with central server', {
      namespace: 'auth',
      error: String(err),
    });
    return null;
  }
}

/** Refuse a valid session that belongs to someone other than this runner's owner. */
function rejectNonOwner(c: Context, userId: string) {
  log.warn('Rejected cookie auth: session user does not own this runner', {
    namespace: 'auth',
    userId,
  });
  return c.json({ error: 'Forbidden: not the owner of this runner' }, 403);
}

/**
 * Middleware that requires admin role.
 */
export async function requireAdmin(c: Context, next: Next) {
  const role = c.get('userRole');
  if (role !== 'admin') {
    return c.json({ error: 'Forbidden: admin required' }, 403);
  }
  return next();
}
