/**
 * Integration tests for /api/invite-links routes (public + protected).
 */
import { mock } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import {
  authMockState,
  createAuthApiMock,
  resetAuthMiddlewareCache,
  resetAuthMockUsers,
} from '../helpers/auth-mock.js';

mock.module('../../lib/auth.js', () => ({
  auth: {
    api: createAuthApiMock(),
  },
}));

mock.module('../../services/ws-relay.js', () => ({
  setIO: () => {},
  addRunnerClient: () => {},
  removeRunnerClient: () => {},
  isRunnerConnected: () => false,
  relayToUser: () => {},
  broadcast: () => {},
  sendToRunner: () => false,
  forwardBrowserMessageToRunner: () => {},
  getAnyConnectedRunnerId: () => null,
  getConnectedBrowserUserIds: () => [],
  getRelayStats: () => ({ runners: 0, browserClients: 0 }),
}));

mock.module('../../services/ws-tunnel.js', () => ({
  setIO: () => {},
  tunnelFetch: () => Promise.reject(new Error('not available in test')),
  TunnelTimeoutError: class TunnelTimeoutError extends Error {
    name = 'TunnelTimeoutError';
  },
  isTunnelTimeoutError: () => false,
}));

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import { eq } from 'drizzle-orm';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedInviteLink } from '../helpers/test-db.js';

const VALID_PASSWORD = 'Password1234';
const orgId = 'org-acme';
const adminId = 'invite-admin';

describe('Invite Links Routes (Integration)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ userId: adminId });
  });

  beforeEach(async () => {
    t.cleanup();
    authMockState.hasPermission = true;
    resetAuthMockUsers();
    await resetAuthMiddlewareCache();
  });

  async function getUseCount(linkId: string): Promise<string | undefined> {
    const schema = await import('../../db/schema.js');
    const row = await t.db
      .select({ useCount: schema.inviteLinks.useCount })
      .from(schema.inviteLinks)
      .where(eq(schema.inviteLinks.id, linkId))
      .then((rows) => rows[0]);
    return row?.useCount;
  }

  describe('GET /api/invite-links/verify/:token (public)', () => {
    test('returns 404 for unknown token', async () => {
      const res = await t.requestAs(adminId).get('/api/invite-links/verify/unknown-token');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Invalid or expired invite link' });
    });

    test('returns 404 for revoked link', async () => {
      seedInviteLink(t.db as any, { token: 'revoked-token', revoked: '1' });

      const res = await t.requestAs(adminId).get('/api/invite-links/verify/revoked-token');
      expect(res.status).toBe(404);
    });

    test('returns 410 for expired link', async () => {
      seedInviteLink(t.db as any, {
        token: 'expired-token',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const res = await t.requestAs(adminId).get('/api/invite-links/verify/expired-token');
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: 'This invite link has expired' });
    });

    test('returns 410 when max uses reached', async () => {
      seedInviteLink(t.db as any, {
        token: 'exhausted-token',
        maxUses: '1',
        useCount: '1',
      });

      const res = await t.requestAs(adminId).get('/api/invite-links/verify/exhausted-token');
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({
        error: 'This invite link has reached its maximum uses',
      });
    });

    test('returns org info for a valid token', async () => {
      seedInviteLink(t.db as any, {
        token: 'valid-token',
        organizationId: orgId,
        role: 'admin',
      });

      const res = await t.requestAs(adminId).get('/api/invite-links/verify/valid-token');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        valid: true,
        role: 'admin',
        organizationName: 'Acme Corp',
        organizationId: orgId,
      });
    });
  });

  describe('POST /api/invite-links/register (public)', () => {
    test('returns 400 when required fields are missing', async () => {
      const res = await t.requestAs(adminId).post('/api/invite-links/register', {
        username: 'newbie',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Token, username, and password are required',
      });
    });

    test('returns 400 for weak password', async () => {
      seedInviteLink(t.db as any, { token: 'register-token' });

      const res = await t.requestAs(adminId).post('/api/invite-links/register', {
        token: 'register-token',
        username: 'newbie',
        password: 'short',
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('Password');
    });

    test('registers a user and consumes an invite slot', async () => {
      const link = seedInviteLink(t.db as any, {
        token: 'register-ok',
        organizationId: orgId,
        maxUses: '2',
      });

      const res = await t.requestAs(adminId).post('/api/invite-links/register', {
        token: 'register-ok',
        username: 'newbie',
        password: VALID_PASSWORD,
        displayName: 'New User',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.user).toEqual({
        id: 'user-newbie',
        username: 'newbie',
        displayName: 'New User',
      });
      expect(body.organizationId).toBe(orgId);
      expect(res.headers.get('set-cookie')).toContain('funny.session=');
      expect(await getUseCount(link.id)).toBe('1');
    });

    test('returns 410 when the link is exhausted', async () => {
      seedInviteLink(t.db as any, {
        token: 'one-shot',
        maxUses: '1',
        useCount: '1',
      });

      const res = await t.requestAs(adminId).post('/api/invite-links/register', {
        token: 'one-shot',
        username: 'late-user',
        password: VALID_PASSWORD,
      });
      expect(res.status).toBe(410);
    });

    test('returns 500 and releases the slot when user creation fails', async () => {
      authMockState.createUserShouldFail = true;
      const link = seedInviteLink(t.db as any, { token: 'create-fail' });

      const res = await t.requestAs(adminId).post('/api/invite-links/register', {
        token: 'create-fail',
        username: 'ghost',
        password: VALID_PASSWORD,
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Failed to create account' });
      expect(await getUseCount(link.id)).toBe('0');
    });

    test('returns generic 400 when user creation throws', async () => {
      authMockState.createUserShouldThrow = true;
      const link = seedInviteLink(t.db as any, { token: 'duplicate-user' });

      const res = await t.requestAs(adminId).post('/api/invite-links/register', {
        token: 'duplicate-user',
        username: 'taken',
        password: VALID_PASSWORD,
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: 'Registration failed. The username may already be taken.',
      });
      expect(await getUseCount(link.id)).toBe('0');
    });
  });

  describe('POST /api/invite-links (protected)', () => {
    test('returns 400 without active organization', async () => {
      const res = await t.requestAs(adminId).post('/api/invite-links', { role: 'member' });
      expect(res.status).toBe(400);
    });

    test('creates an invite link for the active org', async () => {
      const res = await t
        .requestAs(adminId, 'admin', { orgId })
        .post('/api/invite-links', { role: 'admin', expiresInDays: 7, maxUses: 5 });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.role).toBe('admin');
      expect(body.maxUses).toBe(5);
      expect(body.useCount).toBe(0);
      expect(body.token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('GET /api/invite-links (protected)', () => {
    test('returns 400 without active organization', async () => {
      const res = await t.requestAs(adminId).get('/api/invite-links');
      expect(res.status).toBe(400);
    });

    test('lists non-revoked links for the org', async () => {
      seedInviteLink(t.db as any, {
        id: 'link-1',
        organizationId: orgId,
        token: 'listed-token',
      });
      seedInviteLink(t.db as any, {
        id: 'link-2',
        organizationId: orgId,
        token: 'revoked-token',
        revoked: '1',
      });
      seedInviteLink(t.db as any, {
        id: 'link-3',
        organizationId: 'other-org',
        token: 'other-org-token',
      });

      const res = await t.requestAs(adminId, 'admin', { orgId }).get('/api/invite-links');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe('link-1');
      expect(body[0].token).toBe('listed-token');
    });
  });

  describe('DELETE /api/invite-links/:id (protected)', () => {
    test('revokes a link so it no longer appears in the list', async () => {
      seedInviteLink(t.db as any, {
        id: 'to-revoke',
        organizationId: orgId,
        token: 'will-revoke',
      });

      const del = await t
        .requestAs(adminId, 'admin', { orgId })
        .delete('/api/invite-links/to-revoke');
      expect(del.status).toBe(200);
      expect(await del.json()).toEqual({ ok: true });

      const list = await t.requestAs(adminId, 'admin', { orgId }).get('/api/invite-links');
      expect(await list.json()).toEqual([]);
    });
  });

  describe('POST /api/invite-links/accept (protected)', () => {
    test('returns 400 when token is missing', async () => {
      const res = await t.requestAs('existing-user').post('/api/invite-links/accept', {});
      expect(res.status).toBe(400);
    });

    test('returns 404 when user is not found in auth', async () => {
      seedInviteLink(t.db as any, { token: 'accept-token', organizationId: orgId });

      const res = await t.requestAs('missing-user').post('/api/invite-links/accept', {
        token: 'accept-token',
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'User not found' });
    });

    test('accepts a valid invite for an existing user', async () => {
      authMockState.users['existing-user'] = {
        id: 'existing-user',
        email: 'existing@test.com',
        name: 'Existing User',
      };
      seedInviteLink(t.db as any, {
        token: 'accept-ok',
        organizationId: orgId,
        maxUses: '1',
      });

      const res = await t
        .requestAs('existing-user')
        .post('/api/invite-links/accept', { token: 'accept-ok' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, organizationId: orgId });
    });

    test('returns alreadyMember when org join reports duplicate membership', async () => {
      authMockState.users['member-user'] = {
        id: 'member-user',
        email: 'member@test.com',
        name: 'Member User',
      };
      authMockState.inviteMemberError = 'User is already a member';
      seedInviteLink(t.db as any, { token: 'already-member', organizationId: orgId });

      const res = await t
        .requestAs('member-user')
        .post('/api/invite-links/accept', { token: 'already-member' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        organizationId: orgId,
        alreadyMember: true,
      });
    });
  });
});
