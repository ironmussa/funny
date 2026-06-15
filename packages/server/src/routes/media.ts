/**
 * Direct-media URL signing (transport C).
 *
 * POST /api/media/sign  { path }  → { url: string | null }
 *
 * When the requesting user's runner advertised a browser-reachable
 * `publicMediaUrl` (`RUNNER_PUBLIC_MEDIA_URL`), we mint a short-lived HMAC-signed
 * URL to that runner's `/api/files/raw-signed` so the browser streams the media
 * directly from the runner (native Range/seek, no bytes through the WS tunnel).
 * When no public URL is configured, we return `{ url: null }` and the client
 * falls back to the proxied `/api/files/raw` (transport A).
 *
 * Security: the signature only AUTHENTICATES (it proves the server minted it).
 * The runner STILL runs the same per-user project-scope check on redemption, so
 * this endpoint does not need to re-validate the path against the filesystem —
 * it only confirms the user is authenticated and binds {path, userId, expiry}.
 */

import {
  MEDIA_URL_DEFAULT_TTL_MS,
  buildSignedMediaUrl,
} from '@funny/shared/auth/media-url-signature';
import { Hono } from 'hono';

import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { getRunnerPublicMediaUrl } from '../services/runner-manager.js';
import { resolveRunner } from '../services/runner-resolver.js';

export const mediaRoutes = new Hono<ServerEnv>();

mediaRoutes.post('/sign', async (c) => {
  const userId = c.get('userId') as string | undefined;
  if (!userId) return c.json({ error: 'Unauthorized' }, 401);

  let body: { path?: unknown };
  try {
    body = await c.req.json<{ path?: unknown }>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const path = typeof body.path === 'string' ? body.path : '';
  if (!path) return c.json({ error: 'path is required' }, 400);

  const secret = process.env.RUNNER_AUTH_SECRET;
  if (!secret) {
    // No shared secret → cannot sign. Fall back to the tunnel transparently.
    return c.json({ url: null });
  }

  // Resolve the requesting user's runner. With a non-thread/non-project path the
  // resolver falls through to the user's runner (strategy 4) — never another
  // user's runner (the runner-isolation invariant holds).
  const resolved = await resolveRunner(c.req.path, {}, userId);
  if (!resolved) return c.json({ url: null });

  const publicMediaUrl = await getRunnerPublicMediaUrl(resolved.runnerId);
  if (!publicMediaUrl) return c.json({ url: null });

  const url = buildSignedMediaUrl(
    publicMediaUrl,
    { path, userId, expires: Date.now() + MEDIA_URL_DEFAULT_TTL_MS },
    secret,
  );

  log.info('Signed direct-media URL issued', {
    namespace: 'media',
    userId,
    runnerId: resolved.runnerId,
  });

  return c.json({ url });
});
