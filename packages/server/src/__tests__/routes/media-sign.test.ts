/**
 * POST /api/media/sign (transport C). Mints a signed direct-media URL only when
 * the user's runner advertised a public media URL; otherwise returns { url: null }
 * so the client falls back to the proxied (tunnel) endpoint. The signed URL must
 * verify against RUNNER_AUTH_SECRET and bind the requested path + user.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import { MEDIA_SIG_PARAMS, verifyMediaUrl } from '@funny/shared/auth/media-url-signature';
import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { mediaRoutes } from '../../routes/media.js';
import * as runnerManager from '../../services/runner-manager.js';
import * as runnerResolver from '../../services/runner-resolver.js';

function appAs(userId: string | null) {
  const app = new Hono<ServerEnv>();
  app.use('*', async (c, next) => {
    if (userId) c.set('userId', userId);
    return next();
  });
  app.route('/api/media', mediaRoutes);
  return app;
}

function signReq(body: unknown) {
  return new Request('http://localhost/api/media/sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/media/sign', () => {
  afterEach(() => {
    spyOn(runnerResolver, 'resolveRunner').mockRestore();
    spyOn(runnerManager, 'getRunnerPublicMediaUrl').mockRestore();
  });

  beforeEach(() => {
    spyOn(runnerResolver, 'resolveRunner').mockResolvedValue({
      runnerId: 'runner-1',
      httpUrl: 'http://127.0.0.1:3003',
    } as any);
    spyOn(runnerManager, 'getRunnerPublicMediaUrl').mockResolvedValue(null);
  });

  test('401 without a user', async () => {
    const res = await appAs(null).request(signReq({ path: '/p/x.png' }));
    expect(res.status).toBe(401);
  });

  test('400 when path is missing', async () => {
    const res = await appAs('user-1').request(signReq({}));
    expect(res.status).toBe(400);
  });

  test('returns { url: null } when the runner has no public media URL', async () => {
    spyOn(runnerManager, 'getRunnerPublicMediaUrl').mockResolvedValue(null);
    const res = await appAs('user-1').request(signReq({ path: '/p/x.png' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: null });
  });

  test('returns { url: null } when no runner is reachable', async () => {
    spyOn(runnerResolver, 'resolveRunner').mockResolvedValue(null);
    const res = await appAs('user-1').request(signReq({ path: '/p/x.png' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: null });
  });

  test('mints a signed URL that verifies and binds path + user', async () => {
    spyOn(runnerManager, 'getRunnerPublicMediaUrl').mockResolvedValue(
      'https://media.runner.example',
    );

    const res = await appAs('user-1').request(signReq({ path: '/p/x.png' }));
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(typeof url).toBe('string');

    const u = new URL(url);
    expect(u.origin).toBe('https://media.runner.example');
    expect(u.pathname).toBe('/api/files/raw-signed');

    const verified = verifyMediaUrl(
      {
        path: u.searchParams.get(MEDIA_SIG_PARAMS.path),
        userId: u.searchParams.get(MEDIA_SIG_PARAMS.userId),
        expires: u.searchParams.get(MEDIA_SIG_PARAMS.expires),
        signature: u.searchParams.get(MEDIA_SIG_PARAMS.signature),
      },
      'test-secret',
    );
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claim.path).toBe('/p/x.png');
      expect(verified.claim.userId).toBe('user-1');
      expect(verified.claim.expires).toBeGreaterThan(Date.now());
    }
  });
});
