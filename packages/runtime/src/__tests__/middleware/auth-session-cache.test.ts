import { Hono } from 'hono';
/**
 * Security ME-7 regression — runtime session cache.
 *
 * The cache hit is only honoured for read-only methods (GET / HEAD /
 * OPTIONS). Mutating verbs always force a fresh `/api/auth/get-session`
 * round-trip so a stale (post-logout / post-revoke) session can't perform
 * destructive writes during the 15-second cache window.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Set env BEFORE the middleware module is imported. Vitest hoists imports
// AND vi.mock calls above top-level statements, so a bare assignment to
// process.env would run AFTER the middleware's module-scope reads. The
// vi.hoisted callback runs before import resolution.
vi.hoisted(() => {
  process.env.TEAM_SERVER_URL = 'http://server.test';
  process.env.WS_TUNNEL_ONLY = 'false';
  // Polyfill Bun.CryptoHasher — the middleware uses it for the cookie hash
  // key, but vitest runs under Node so the global doesn't exist.
  const cryptoMod = require('crypto') as typeof import('crypto');
  if (typeof (globalThis as any).Bun === 'undefined') {
    (globalThis as any).Bun = {
      CryptoHasher: class {
        private hasher: ReturnType<typeof cryptoMod.createHash>;
        constructor(algo: string) {
          this.hasher = cryptoMod.createHash(algo);
        }
        update(data: string | Buffer) {
          this.hasher.update(data);
          return this;
        }
        digest(encoding: 'hex') {
          return this.hasher.digest(encoding);
        }
      },
    };
  }
});

// Stub the lib/auth.js dynamic import so Better Auth doesn't initialise.
vi.mock('../../lib/auth.js', () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));

import { authMiddleware } from '../../middleware/auth.js';

const sessionPayload = {
  user: { id: 'user-1', role: 'user' },
  session: { activeOrganizationId: null },
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
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
    // Mutating verb re-validates → no user.id in payload → falls through and
    // ends at Better Auth (mocked to null) → 401.
    expect(res.status).toBe(401);
  });
});
