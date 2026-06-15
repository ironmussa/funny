/**
 * @domain subdomain: Authentication
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Runtime auth middleware.
 *
 * The runtime always runs as a remote runner connected to the central server.
 * Auth priority:
 * 1. **X-Runner-Auth + signed identity** — shared secret from server proxy
 *    plus an HMAC over `userId|role|orgId|orgName|timestamp|nonce` in the
 *    `X-Forwarded-Signature` / `X-Forwarded-Timestamp` / `X-Forwarded-Nonce`
 *    headers. The signature prevents a caller that does NOT hold the shared
 *    secret (e.g. a browser hitting this runner's HTTP port directly) from
 *    forging `X-Forwarded-User`. It does NOT defend against a holder of the
 *    secret — see the trust-boundary note in
 *    `@funny/shared/auth/forwarded-identity`. The per-request nonce makes
 *    every signature unique so parallel requests in the same millisecond
 *    don't false-trip the replay cache.
 * 2. **Server session** — browser cookie validated against TEAM_SERVER_URL
 * 3. **Better Auth** — local session fallback
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

/** Paths that skip authentication entirely */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/mode',
  '/api/bootstrap',
  '/api/mcp/oauth/callback',
]);

const TEAM_SERVER_URL = process.env.TEAM_SERVER_URL;
const WS_TUNNEL_ONLY = process.env.WS_TUNNEL_ONLY === 'true' || process.env.WS_TUNNEL_ONLY === '1';

// Cache validated sessions: cookie hash → { userId, role, orgId, expiresAt }
const sessionCache = new Map<
  string,
  { userId: string; role: string; orgId: string | null; expiresAt: number }
>();
const SESSION_CACHE_TTL = 15_000; // 15 seconds — balance between performance and session revocation freshness

/**
 * Security ME-7: cache lookups are only honoured for read-only methods
 * (GET / HEAD / OPTIONS). A user who logged out continues to see cached
 * authorization for read traffic for up to `SESSION_CACHE_TTL`, but any
 * mutating verb forces a fresh `/api/auth/get-session` round-trip so a
 * stale session can't perform destructive writes during the cache window.
 */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Direct auth middleware — validates sessions without relying on forwarded headers.
 *
 * Priority:
 * 1. Server session validation (browser → runtime with server cookie, when TEAM_SERVER_URL is set)
 * 2. Better Auth session (fallback for local sessions)
 */
export async function authMiddleware(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname;

  if (PUBLIC_PATHS.has(path)) return next();

  // ── Forwarded auth from server via shared secret ──
  //
  // The shared secret proves the request went through the server proxy path.
  // The HMAC signature proves the forwarded identity headers were set by the
  // server (not spoofed by a client that happens to know the secret). Both
  // checks must pass before we trust `X-Forwarded-User`.
  const RUNNER_AUTH_SECRET = process.env.RUNNER_AUTH_SECRET;
  const runnerAuthHeader = c.req.header('X-Runner-Auth');
  if (
    RUNNER_AUTH_SECRET &&
    runnerAuthHeader &&
    runnerAuthHeader.length === RUNNER_AUTH_SECRET.length &&
    timingSafeEqual(Buffer.from(runnerAuthHeader), Buffer.from(RUNNER_AUTH_SECRET))
  ) {
    const userId = c.req.header('X-Forwarded-User');
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);

    const role = c.req.header('X-Forwarded-Role') || 'user';
    const orgId = c.req.header('X-Forwarded-Org') || null;
    const orgName = c.req.header('X-Forwarded-Org-Name') || null;
    // Steer-share delegation claim (thread-sharing-steer). Part of the signed
    // payload, so it cannot be forged by a caller without the secret.
    const shareLevel = c.req.header(SHARE_LEVEL_HEADER) || null;
    const onBehalfOfThread = c.req.header(ON_BEHALF_OF_THREAD_HEADER) || null;

    const signature = c.req.header(SIGNATURE_HEADER);
    const timestamp = c.req.header(TIMESTAMP_HEADER);
    const nonce = c.req.header(NONCE_HEADER);
    const valid = verifyForwardedIdentity(
      { userId, role, orgId, orgName, shareLevel, onBehalfOfThread },
      RUNNER_AUTH_SECRET,
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

  // ── Server session validation (when connected to a central server) ──
  // Skip in WS-only mode — all requests arrive via tunnel with X-Runner-Auth already set
  if (TEAM_SERVER_URL && !WS_TUNNEL_ONLY && c.req.header('Cookie')) {
    const cookie = c.req.header('Cookie')!;
    const cacheKey = new Bun.CryptoHasher('sha256').update(cookie).digest('hex');

    const cached = sessionCache.get(cacheKey);
    // Security ME-7: read traffic may use the cache; mutating verbs must
    // re-validate so a stale (post-logout / post-revoke) session can't be
    // used to perform destructive writes during the cache window.
    if (cached && cached.expiresAt > Date.now() && READ_ONLY_METHODS.has(c.req.method)) {
      c.set('userId', cached.userId);
      c.set('userRole', cached.role);
      c.set('organizationId', cached.orgId);
      c.set('organizationName', null);
      return next();
    }

    try {
      const forwardCookie = cookie.replace(/\bbetter-auth\./g, '__Secure-better-auth.');
      const res = await fetch(`${TEAM_SERVER_URL}/api/auth/get-session`, {
        headers: { Cookie: forwardCookie },
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data?.user?.id) {
          const entry = {
            userId: data.user.id as string,
            role: (data.user.role as string) || 'user',
            orgId: (data.session?.activeOrganizationId as string) ?? null,
            expiresAt: Date.now() + SESSION_CACHE_TTL,
          };
          sessionCache.set(cacheKey, entry);
          c.set('userId', entry.userId);
          c.set('userRole', entry.role);
          c.set('organizationId', entry.orgId);
          c.set('organizationName', null);
          return next();
        }
      }
    } catch (err) {
      log.warn('Failed to validate session with central server', {
        namespace: 'auth',
        error: String(err),
      });
    }
    // Fall through to local Better Auth
  }

  // ── Better Auth session ────────────────────────────────────────
  if (path.startsWith('/api/auth/')) return next();

  const { auth } = await import('../lib/auth.js');
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: 'Unauthorized' }, 401);

  c.set('userId', session.user.id);
  c.set('userRole', (session.user as any).role || 'user');
  c.set('organizationId', (session.session as any).activeOrganizationId ?? null);
  c.set('organizationName', null);

  return next();
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

/**
 * Middleware factory that checks if the user has a specific permission
 * in their active organization.
 */
export function requirePermission(resource: string, action: string) {
  return async (c: Context, next: Next) => {
    const orgId = c.get('organizationId');
    if (!orgId) return next();

    const { auth } = await import('../lib/auth.js');
    try {
      const hasPermission = await auth.api.hasPermission({
        headers: c.req.raw.headers,
        body: {
          permission: {
            [resource]: [action],
          },
        },
      });

      if (!hasPermission) {
        return c.json({ error: `Forbidden: ${resource}:${action} permission required` }, 403);
      }
    } catch (err) {
      log.warn('Permission check failed — denying access', {
        namespace: 'auth',
        resource,
        action,
        error: String(err),
      });
      return c.json({ error: 'Forbidden: permission check failed' }, 403);
    }

    return next();
  };
}
