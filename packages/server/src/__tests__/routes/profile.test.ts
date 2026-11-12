/**
 * Integration tests for the REST user profile routes.
 *
 * Tests user profile CRUD, runner invite token management, and setup
 * completion tracking. (The SMTP and agent-profile settings routes moved to
 * tRPC; see profile-settings-trpc.test.ts.)
 */

import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('Profile Routes (Integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
  });

  // ── User Profile ───────────────────────────────────────

  describe('GET /api/profile', () => {
    test('returns defaults when no profile exists', async () => {
      const res = await t.requestAs('new-user').get('/api/profile');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.userId).toBe('new-user');
      expect(body.gitName).toBeNull();
      expect(body.gitEmail).toBeNull();
      expect(body.hasGithubToken).toBe(false);
      expect(body.setupCompleted).toBe(false);
    });
  });

  describe('PUT /api/profile', () => {
    test('creates profile on first PUT', async () => {
      const putRes = await t.requestAs('user-1').put('/api/profile', {
        gitName: 'John Doe',
        gitEmail: 'john@example.com',
        theme: 'dark',
      });
      expect(putRes.status).toBe(200);
      const profile = await putRes.json();
      expect(profile.gitName).toBe('John Doe');
      expect(profile.gitEmail).toBe('john@example.com');
      expect(profile.theme).toBe('dark');

      // Verify via GET
      const getRes = await t.requestAs('user-1').get('/api/profile');
      const body = await getRes.json();
      expect(body.gitName).toBe('John Doe');
      expect(body.theme).toBe('dark');
    });

    test('updates existing profile fields', async () => {
      // Create
      await t.requestAs('user-1').put('/api/profile', {
        gitName: 'Old Name',
        gitEmail: 'old@example.com',
      });

      // Update
      const putRes = await t.requestAs('user-1').put('/api/profile', {
        gitName: 'New Name',
      });
      const profile = await putRes.json();
      expect(profile.gitName).toBe('New Name');
      expect(profile.gitEmail).toBe('old@example.com'); // preserved
    });

    test('stores GitHub token encrypted (only exposes hasGithubToken)', async () => {
      await t.requestAs('user-1').put('/api/profile', {
        githubToken: 'ghp_test123456',
      });

      const getRes = await t.requestAs('user-1').get('/api/profile');
      const body = await getRes.json();
      expect(body.hasGithubToken).toBe(true);
      // Token itself should NOT be exposed
      expect(body.githubToken).toBeUndefined();
    });

    test('persists setupCompleted flag', async () => {
      await t.requestAs('user-1').put('/api/profile', {
        setupCompleted: true,
      });

      const getRes = await t.requestAs('user-1').get('/api/profile/setup-completed');
      const body = await getRes.json();
      expect(body.setupCompleted).toBe(true);
    });

    test('persists tool permissions as JSON', async () => {
      const permissions = { Edit: 'allow', Bash: 'ask' };
      await t.requestAs('user-1').put('/api/profile', {
        toolPermissions: permissions,
      });

      const getRes = await t.requestAs('user-1').get('/api/profile');
      const body = await getRes.json();
      expect(body.toolPermissions).toEqual(permissions);
    });

    test('each user has isolated profile', async () => {
      await t.requestAs('user-1').put('/api/profile', { gitName: 'User 1' });
      await t.requestAs('user-2').put('/api/profile', { gitName: 'User 2' });

      const res1 = await t.requestAs('user-1').get('/api/profile');
      const res2 = await t.requestAs('user-2').get('/api/profile');
      expect((await res1.json()).gitName).toBe('User 1');
      expect((await res2.json()).gitName).toBe('User 2');
    });
  });

  // ── Agent Execution Profiles ───────────────────────────

  // ── Runner Invite Token ────────────────────────────────

  describe('GET /api/profile/runner-invite-token', () => {
    test('auto-creates token on first request', async () => {
      const res = await t.requestAs('user-1').get('/api/profile/runner-invite-token');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.token).toMatch(/^utkn_/);
    });

    test('returns same token on subsequent requests', async () => {
      const res1 = await t.requestAs('user-1').get('/api/profile/runner-invite-token');
      const body1 = await res1.json();

      const res2 = await t.requestAs('user-1').get('/api/profile/runner-invite-token');
      const body2 = await res2.json();

      expect(body2.token).toBe(body1.token);
    });
  });

  describe('POST /api/profile/runner-invite-token/rotate', () => {
    test('generates a new token different from the old one', async () => {
      // Get initial token
      const res1 = await t.requestAs('user-1').get('/api/profile/runner-invite-token');
      const oldToken = (await res1.json()).token;

      // Rotate
      const rotateRes = await t.requestAs('user-1').post('/api/profile/runner-invite-token/rotate');
      expect(rotateRes.status).toBe(200);
      const newToken = (await rotateRes.json()).token;

      expect(newToken).toMatch(/^utkn_/);
      expect(newToken).not.toBe(oldToken);

      // Verify new token is returned on subsequent GET
      const res2 = await t.requestAs('user-1').get('/api/profile/runner-invite-token');
      expect((await res2.json()).token).toBe(newToken);
    });
  });

  // ── Setup Completed ────────────────────────────────────

  describe('GET /api/profile/setup-completed', () => {
    test('returns false when no profile', async () => {
      const res = await t.requestAs('new-user').get('/api/profile/setup-completed');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.setupCompleted).toBe(false);
    });

    test('returns true after marking setup complete', async () => {
      await t.requestAs('user-1').put('/api/profile', { setupCompleted: true });

      const res = await t.requestAs('user-1').get('/api/profile/setup-completed');
      const body = await res.json();
      expect(body.setupCompleted).toBe(true);
    });
  });
});
