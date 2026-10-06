import { Hono } from 'hono';
import { describe, test, expect, beforeEach, vi } from 'vitest';

import type { HonoEnv } from '../../types/hono-env.js';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

// Mock Better Auth
const mockGetSession = vi.fn<() => Promise<any | null>>(() => Promise.resolve(null));
vi.mock('../../lib/auth.js', () => ({
  auth: {
    api: {
      getSession: mockGetSession,
    },
  },
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are registered
// ---------------------------------------------------------------------------

const { authMiddleware, requireAdmin } = await import('../../middleware/auth.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fresh Hono app with authMiddleware applied to all routes. */
function createApp() {
  const app = new Hono<HonoEnv>();
  app.use('*', authMiddleware);
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/auth/mode', (c) => c.json({ mode: 'multi' }));
  app.get('/api/bootstrap', (c) => c.json({ bootstrapped: true }));
  app.get('/api/auth/login', (c) => c.json({ login: true }));
  app.get('/api/auth/some-other', (c) => c.json({ auth: true }));
  app.get('/api/mcp/oauth/callback', (c) => c.json({ callback: true }));
  app.get('/api/projects', (c) => c.json({ userId: c.get('userId'), role: c.get('userRole') }));
  return app;
}

/** Build a Hono app where `user` is already authenticated, guarded by requireAdmin. */
function createAdminApp(user: { id: string; role?: string }) {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', user.id);
    c.set('userRole', user.role as any);
    await next();
  });
  app.use('/api/admin/*', requireAdmin);
  app.get('/api/admin/users', (c) => c.json({ userId: c.get('userId'), role: c.get('userRole') }));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('authMiddleware', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
  });

  // -----------------------------------------------------------------------
  // Public paths — bypass auth
  // -----------------------------------------------------------------------

  describe('public paths bypass auth', () => {
    test('/api/health bypasses auth', async () => {
      const app = createApp();
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });

    test('/api/auth/mode bypasses auth', async () => {
      const app = createApp();
      const res = await app.request('/api/auth/mode');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ mode: 'multi' });
    });

    test('/api/bootstrap bypasses auth', async () => {
      const app = createApp();
      const res = await app.request('/api/bootstrap');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ bootstrapped: true });
    });

    test('public paths bypass auth even without any credentials', async () => {
      const app = createApp();
      for (const path of ['/api/health', '/api/auth/mode', '/api/bootstrap']) {
        const res = await app.request(path);
        expect(res.status).toBe(200);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Auth route bypass
  // -----------------------------------------------------------------------

  describe('no local session fallback', () => {
    // Regression: the runner used to fall back to a local Better Auth instance
    // (its own legacy DB) and let every `/api/auth/*` path through without
    // credentials. The runner has no auth DB — anything not forwarded by the
    // server or validated against it must be 401, without touching Better Auth.
    test('a request local Better Auth would accept is still 401', async () => {
      mockGetSession.mockResolvedValue({
        user: { id: 'user-42', role: 'admin' },
        session: { activeOrganizationId: null },
      });

      const res = await createApp().request('/api/projects');

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expect(mockGetSession).not.toHaveBeenCalled();
    });

    test('/api/auth/* paths other than /api/auth/mode require credentials', async () => {
      const app = createApp();
      expect((await app.request('/api/auth/login')).status).toBe(401);
      expect((await app.request('/api/auth/some-other')).status).toBe(401);
    });

    test('/api/mcp/oauth/callback bypasses auth', async () => {
      const res = await createApp().request('/api/mcp/oauth/callback');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ callback: true });
    });
  });
});

// ---------------------------------------------------------------------------
// requireAdmin
// ---------------------------------------------------------------------------

describe('requireAdmin', () => {
  test('returns 403 for non-admin user', async () => {
    const app = createAdminApp({ id: 'user-regular', role: 'user' });
    const res = await app.request('/api/admin/users');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'Forbidden: admin required' });
  });

  test('allows admin user', async () => {
    const app = createAdminApp({ id: 'user-admin', role: 'admin' });
    const res = await app.request('/api/admin/users');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('user-admin');
    expect(body.role).toBe('admin');
  });

  test('returns 403 when role is undefined (no role set)', async () => {
    const app = createAdminApp({ id: 'user-norole' });
    const res = await app.request('/api/admin/users');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'Forbidden: admin required' });
  });
});
