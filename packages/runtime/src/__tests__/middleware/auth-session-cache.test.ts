/**
 * Security ME-7 regression — runtime session cache.
 *
 * The cache hit is only honoured for read-only methods (GET / HEAD /
 * OPTIONS). Mutating verbs always force a fresh `/api/auth/get-session`
 * round-trip so a stale (post-logout / post-revoke) session can't perform
 * destructive writes during the 15-second cache window.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';

import { Hono } from 'hono';

// Set env BEFORE the middleware module is imported: it reads TEAM_SERVER_URL
// and WS_TUNNEL_ONLY at module scope. Static imports run before this file's
// body, so the middleware is imported dynamically below, after the env and
// the mock are in place.
process.env.TEAM_SERVER_URL = 'http://server.test';
process.env.WS_TUNNEL_ONLY = 'false';

// Stub the lib/auth.js dynamic import so Better Auth doesn't initialise.
vi.mock('../../lib/auth.js', () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));

const { configureRunnerKeys } = await import('../../lib/runner-keys.js');
const { authMiddleware } = await import('../../middleware/auth.js');

const sessionPayload = {
  user: { id: 'user-1', role: 'user' },
  session: { activeOrganizationId: null },
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Cookie auth is owner-only (security H7); the session user owns this runner.
  configureRunnerKeys({ runnerId: 'runner-1', ownerUserId: 'user-1' });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(sessionPayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.get('/api/resource', (c) => c.json({ ok: true, method: 'GET' }));
  app.post('/api/resource', (c) => c.json({ ok: true, method: 'POST' }));
  app.patch('/api/resource', (c) => c.json({ ok: true, method: 'PATCH' }));
  app.delete('/api/resource', (c) => c.json({ ok: true, method: 'DELETE' }));
  return app;
}

const COOKIE = 'better-auth.session_token=abc123';

describe('runtime session cache — read-only methods only (security ME-7)', () => {
  test('first GET validates against server (cache miss)', async () => {
    const app = buildApp();
    const res = await app.request('/api/resource', { headers: { Cookie: COOKIE } });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('second GET hits the cache (no extra fetch)', async () => {
    const app = buildApp();
    await app.request('/api/resource', { headers: { Cookie: COOKIE } });
    fetchSpy.mockClear();
    const res = await app.request('/api/resource', { headers: { Cookie: COOKIE } });
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('POST after a cached GET re-validates (cache bypass for mutating verb)', async () => {
    const app = buildApp();
    await app.request('/api/resource', { headers: { Cookie: COOKIE } });
    fetchSpy.mockClear();
    const res = await app.request('/api/resource', { method: 'POST', headers: { Cookie: COOKIE } });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('PATCH bypasses the cache', async () => {
    const app = buildApp();
    await app.request('/api/resource', { headers: { Cookie: COOKIE } });
    fetchSpy.mockClear();
    const res = await app.request('/api/resource', {
      method: 'PATCH',
      headers: { Cookie: COOKIE },
    });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('DELETE bypasses the cache', async () => {
    const app = buildApp();
    await app.request('/api/resource', { headers: { Cookie: COOKIE } });
    fetchSpy.mockClear();
    const res = await app.request('/api/resource', {
      method: 'DELETE',
      headers: { Cookie: COOKIE },
    });
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('after a logged-out user (server returns null) the POST fails 401 even if a cached GET exists', async () => {
    const app = buildApp();
    // Prime the cache with a valid session.
    await app.request('/api/resource', { headers: { Cookie: COOKIE } });
    // Now the server starts returning logged-out responses.
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const res = await app.request('/api/resource', { method: 'POST', headers: { Cookie: COOKIE } });
    // Mutating verb re-validates → no user.id in payload → 401.
    expect(res.status).toBe(401);
  });
});
