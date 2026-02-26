import { describe, test, expect, beforeEach, mock } from 'bun:test';

import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockGetAuthMode = mock(() => 'local' as 'local' | 'multi');
const mockValidateToken = mock(() => true);

mock.module('../../lib/auth-mode.js', () => ({
  getAuthMode: mockGetAuthMode,
}));

mock.module('../../services/auth-service.js', () => ({
  validateToken: mockValidateToken,
}));

// Mock Better Auth — only used in multi mode tests
const mockGetSession = mock(() => Promise.resolve(null));
mock.module('../../lib/auth.js', () => ({
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
  const app = new Hono();
  app.use('*', authMiddleware);
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/auth/mode', (c) => c.json({ mode: 'local' }));
  app.get('/api/bootstrap', (c) => c.json({ bootstrapped: true }));
  app.get('/api/auth/login', (c) => c.json({ login: true }));
  app.get('/api/auth/some-other', (c) => c.json({ auth: true }));
  app.get('/api/mcp/oauth/callback', (c) => c.json({ callback: true }));
  app.get('/api/projects', (c) => c.json({ userId: c.get('userId'), role: c.get('userRole') }));
  return app;
}

/** Build a Hono app with authMiddleware + requireAdmin chained. */
function createAdminApp() {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.use('/api/admin/*', requireAdmin);
  app.get('/api/admin/users', (c) => c.json({ userId: c.get('userId'), role: c.get('userRole') }));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('authMiddleware', () => {
  beforeEach(() => {
    mockGetAuthMode.mockReset();
    mockValidateToken.mockReset();
    mockGetSession.mockReset();

    // Defaults: local mode, valid token
    mockGetAuthMode.mockReturnValue('local');
    mockValidateToken.mockReturnValue(true);
  });

  // -----------------------------------------------------------------------
  // Public paths — bypass auth regardless of mode
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
      expect(body).toEqual({ mode: 'local' });
    });

    test('/api/bootstrap bypasses auth', async () => {
      const app = createApp();
      const res = await app.request('/api/bootstrap');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ bootstrapped: true });
    });

    test('public paths bypass auth even without Authorization header', async () => {
      const app = createApp();

      // No Authorization header — should still work for public paths
      for (const path of ['/api/health', '/api/auth/mode', '/api/bootstrap']) {
        const res = await app.request(path);
        expect(res.status).toBe(200);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Local mode
  // -----------------------------------------------------------------------

  describe('local mode', () => {
    beforeEach(() => {
      mockGetAuthMode.mockReturnValue('local');
    });

    test('/api/auth/* paths bypass auth', async () => {
      const app = createApp();
      const res = await app.request('/api/auth/login');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ login: true });
    });

    test('/api/auth/some-other also bypasses auth', async () => {
      const app = createApp();
      const res = await app.request('/api/auth/some-other');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ auth: true });
    });

    test('/api/mcp/oauth/callback bypasses auth', async () => {
      const app = createApp();
      const res = await app.request('/api/mcp/oauth/callback');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ callback: true });
    });

    test('missing Authorization header returns 401', async () => {
      const app = createApp();
      const res = await app.request('/api/projects');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    test('invalid token returns 401', async () => {
      mockValidateToken.mockReturnValue(false);

      const app = createApp();
      const res = await app.request('/api/projects', {
        headers: { Authorization: 'Bearer bad-token' },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    test('valid bearer token passes and sets userId to __local__', async () => {
      mockValidateToken.mockReturnValue(true);

      const app = createApp();
      const res = await app.request('/api/projects', {
        headers: { Authorization: 'Bearer valid-token-123' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe('__local__');
      expect(body.role).toBe('admin');
    });

    test('non-Bearer scheme returns 401', async () => {
      const app = createApp();
      const res = await app.request('/api/projects', {
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    test('malformed Authorization header (no space) returns 401', async () => {
      const app = createApp();
      const res = await app.request('/api/projects', {
        headers: { Authorization: 'BearerNoSpace' },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    test('Authorization header with extra parts returns 401', async () => {
      const app = createApp();
      const res = await app.request('/api/projects', {
        headers: { Authorization: 'Bearer token extra' },
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    test('validateToken is called with the provided token value', async () => {
      mockValidateToken.mockReturnValue(true);

      const app = createApp();
      await app.request('/api/projects', {
        headers: { Authorization: 'Bearer my-secret-token' },
      });

      expect(mockValidateToken).toHaveBeenCalledWith('my-secret-token');
    });
  });

  // -----------------------------------------------------------------------
  // Multi mode
  // -----------------------------------------------------------------------

  describe('multi mode', () => {
    beforeEach(() => {
      mockGetAuthMode.mockReturnValue('multi');
    });

    test('/api/auth/* paths bypass auth in multi mode', async () => {
      const app = createApp();
      const res = await app.request('/api/auth/login');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ login: true });
    });

    test('/api/mcp/oauth/callback bypasses auth in multi mode', async () => {
      const app = createApp();
      const res = await app.request('/api/mcp/oauth/callback');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ callback: true });
    });

    test('returns 401 when no session exists', async () => {
      mockGetSession.mockResolvedValue(null);

      const app = createApp();
      const res = await app.request('/api/projects');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: 'Unauthorized' });
    });

    test('valid session sets userId and userRole', async () => {
      mockGetSession.mockResolvedValue({
        user: { id: 'user-42', role: 'admin' },
      });

      const app = createApp();
      const res = await app.request('/api/projects');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe('user-42');
      expect(body.role).toBe('admin');
    });

    test('session user without role defaults to "user"', async () => {
      mockGetSession.mockResolvedValue({
        user: { id: 'user-99' },
      });

      const app = createApp();
      const res = await app.request('/api/projects');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe('user-99');
      expect(body.role).toBe('user');
    });
  });
});

// ---------------------------------------------------------------------------
// requireAdmin
// ---------------------------------------------------------------------------

describe('requireAdmin', () => {
  beforeEach(() => {
    mockGetAuthMode.mockReset();
    mockValidateToken.mockReset();
    mockGetSession.mockReset();

    mockGetAuthMode.mockReturnValue('local');
    mockValidateToken.mockReturnValue(true);
  });

  test('local mode always passes (everyone is admin)', async () => {
    mockGetAuthMode.mockReturnValue('local');
    mockValidateToken.mockReturnValue(true);

    const app = createAdminApp();
    const res = await app.request('/api/admin/users', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('__local__');
    expect(body.role).toBe('admin');
  });

  test('multi mode returns 403 for non-admin user', async () => {
    mockGetAuthMode.mockReturnValue('multi');
    mockGetSession.mockResolvedValue({
      user: { id: 'user-regular', role: 'user' },
    });

    const app = createAdminApp();
    const res = await app.request('/api/admin/users');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'Forbidden: admin required' });
  });

  test('multi mode allows admin user', async () => {
    mockGetAuthMode.mockReturnValue('multi');
    mockGetSession.mockResolvedValue({
      user: { id: 'user-admin', role: 'admin' },
    });

    const app = createAdminApp();
    const res = await app.request('/api/admin/users');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe('user-admin');
    expect(body.role).toBe('admin');
  });

  test('multi mode returns 403 when role is undefined (no role set)', async () => {
    mockGetAuthMode.mockReturnValue('multi');
    mockGetSession.mockResolvedValue({
      user: { id: 'user-norole' },
    });

    const app = createAdminApp();
    const res = await app.request('/api/admin/users');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'Forbidden: admin required' });
  });
});
