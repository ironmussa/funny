/**
 * Security HI-13 regression — loopback runner registration must NOT
 * silently bind to the first admin user. Operators have to opt in via
 * `FUNNY_LOOPBACK_RUNNER_USERNAME`; without it the request is refused
 * with guidance to use the invite-token flow.
 */
import { mock } from 'bun:test';

mock.module('@funny/core/git', () => ({
  isGitRepoSync: () => true,
  isGitRepoRootSync: () => true,
  ensureWeaveConfigured: () => Promise.resolve(),
}));

// Required for the X-Runner-Auth branch to evaluate.
process.env.RUNNER_AUTH_SECRET = 'loopback-test-secret';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { sql } from 'drizzle-orm';
import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { authMiddleware } from '../../middleware/auth.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

const ORIGINAL_OPT_IN = process.env.FUNNY_LOOPBACK_RUNNER_USERNAME;

afterAll(() => {
  if (ORIGINAL_OPT_IN !== undefined) {
    process.env.FUNNY_LOOPBACK_RUNNER_USERNAME = ORIGINAL_OPT_IN;
  } else {
    delete process.env.FUNNY_LOOPBACK_RUNNER_USERNAME;
  }
});

describe('Loopback runner registration (security HI-13)', () => {
  let t: TestApp;
  let app: Hono<ServerEnv>;

  beforeAll(async () => {
    t = await createTestApp();
    // Mount a bare app with the real auth middleware and a stub handler
    // that confirms the middleware passed.
    app = new Hono<ServerEnv>();
    app.use('*', authMiddleware);
    app.post('/api/runners/register', (c) =>
      c.json({ ok: true, userId: c.get('userId') ?? null, isRunner: c.get('isRunner') ?? null }),
    );
    // Seed a user table row that the FUNNY_LOOPBACK_RUNNER_USERNAME branch
    // can resolve. Reuse the test app's DB connection.
    (t.db as any).run(
      sql`INSERT INTO "user" (id, name, email, email_verified, username, role, created_at, updated_at)
          VALUES ('user-loopback', 'Loopback User', 'lb@example', 1, 'allowed-runner', 'user', '2026-01-01', '2026-01-01')`,
    );
  });

  beforeEach(() => {
    delete process.env.FUNNY_LOOPBACK_RUNNER_USERNAME;
  });

  afterEach(() => {
    delete process.env.FUNNY_LOOPBACK_RUNNER_USERNAME;
  });

  test('rejects 401 when FUNNY_LOOPBACK_RUNNER_USERNAME is unset', async () => {
    const res = await app.request('/api/runners/register', {
      method: 'POST',
      headers: { 'X-Runner-Auth': 'loopback-test-secret' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/X-Runner-Invite-Token|FUNNY_LOOPBACK_RUNNER_USERNAME/);
  });

  test('resolves to the named user when FUNNY_LOOPBACK_RUNNER_USERNAME points at a real account', async () => {
    process.env.FUNNY_LOOPBACK_RUNNER_USERNAME = 'allowed-runner';
    const res = await app.request('/api/runners/register', {
      method: 'POST',
      headers: { 'X-Runner-Auth': 'loopback-test-secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string | null; isRunner: boolean };
    expect(body.userId).toBe('user-loopback');
    expect(body.isRunner).toBe(true);
  });

  test('500 when FUNNY_LOOPBACK_RUNNER_USERNAME points at a non-existent user', async () => {
    process.env.FUNNY_LOOPBACK_RUNNER_USERNAME = 'ghost-user';
    const res = await app.request('/api/runners/register', {
      method: 'POST',
      headers: { 'X-Runner-Auth': 'loopback-test-secret' },
    });
    expect(res.status).toBe(500);
  });

  test('still works for non-register paths under the shared-secret branch (isRunner=true)', async () => {
    // Non-register paths under the shared secret should NOT need the opt-in.
    // The opt-in gate is specifically for registration.
    const sideApp = new Hono<ServerEnv>();
    sideApp.use('*', authMiddleware);
    sideApp.get('/api/anything', (c) =>
      c.json({ isRunner: c.get('isRunner'), userId: c.get('userId') ?? null }),
    );
    const res = await sideApp.request('/api/anything', {
      headers: { 'X-Runner-Auth': 'loopback-test-secret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isRunner: boolean };
    expect(body.isRunner).toBe(true);
  });
});
