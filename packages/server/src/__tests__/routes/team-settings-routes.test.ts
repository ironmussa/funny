/**
 * Team settings routes — org settings, API key encryption, defaults.
 */
import { mock } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const testDir = mkdtempSync(join(tmpdir(), 'funny-team-settings-'));
process.env.FUNNY_DATA_DIR = testDir;

import {
  authMockState,
  createAuthApiMock,
  resetAuthMiddlewareCache,
} from '../helpers/auth-mock.js';

const updateOrgCalls: unknown[] = [];

const mockOrg = {
  id: 'org-1',
  name: 'Acme Team',
  slug: 'acme',
  logo: null,
  anthropicApiKey: null as string | null,
  defaultModel: 'sonnet',
  defaultMode: 'worktree',
  defaultPermissionMode: 'autoEdit',
};

mock.module('../../lib/auth.js', () => ({
  auth: {
    api: createAuthApiMock({
      getFullOrganization: async ({ query }: { query: { organizationId: string } }) => {
        if (query.organizationId === 'missing-org') return null;
        return mockOrg;
      },
      updateOrganization: async (args: unknown) => {
        updateOrgCalls.push(args);
      },
    }),
  },
}));

import { describe, test, expect, beforeEach } from 'bun:test';

import { Hono } from 'hono';

import { encrypt } from '../../lib/crypto.js';
import type { ServerEnv } from '../../lib/types.js';
import { getOrgApiKey, teamSettingsRoutes } from '../../routes/team-settings.js';

function createApp(orgId: string | null) {
  const app = new Hono<ServerEnv>();
  app.use('*', async (c, next) => {
    c.set('organizationId', orgId);
    c.set('userId', 'user-1');
    return next();
  });
  app.route('/api/team-settings', teamSettingsRoutes);
  return app;
}

describe('team settings routes', () => {
  beforeEach(async () => {
    updateOrgCalls.length = 0;
    authMockState.hasPermission = true;
    mockOrg.anthropicApiKey = null;
    await resetAuthMiddlewareCache();
  });

  describe('GET /api/team-settings', () => {
    test('returns 400 when no active organization', async () => {
      const res = await createApp(null).request('/api/team-settings');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'No active organization' });
    });

    test('returns 404 when organization is not found', async () => {
      const res = await createApp('missing-org').request('/api/team-settings');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Organization not found' });
    });

    test('returns org settings without exposing the raw API key', async () => {
      mockOrg.anthropicApiKey = encrypt('sk-secret');

      const res = await createApp('org-1').request('/api/team-settings');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        id: 'org-1',
        name: 'Acme Team',
        slug: 'acme',
        logo: null,
        hasApiKey: true,
        defaultModel: 'sonnet',
        defaultMode: 'worktree',
        defaultPermissionMode: 'autoEdit',
      });
      expect(body).not.toHaveProperty('anthropicApiKey');
      expect(body).not.toHaveProperty('apiKey');
    });
  });

  describe('PUT /api/team-settings/api-key', () => {
    test('returns 400 when no active organization', async () => {
      const res = await createApp(null).request('/api/team-settings/api-key', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: 'sk-test' }),
      });
      expect(res.status).toBe(400);
    });

    test('returns 403 when member:update permission is denied', async () => {
      authMockState.hasPermission = false;

      const res = await createApp('org-1').request('/api/team-settings/api-key', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: 'sk-test' }),
      });

      expect(res.status).toBe(403);
      expect(updateOrgCalls).toHaveLength(0);
    });

    test('encrypts and stores the API key', async () => {
      const res = await createApp('org-1').request('/api/team-settings/api-key', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: 'sk-test-key' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, hasApiKey: true });
      expect(updateOrgCalls).toHaveLength(1);

      const call = updateOrgCalls[0] as {
        body: { organizationId: string; data: { anthropicApiKey: string } };
      };
      expect(call.body.organizationId).toBe('org-1');
      expect(call.body.data.anthropicApiKey).toMatch(/^v1:/);
      expect(call.body.data.anthropicApiKey).not.toBe('sk-test-key');
    });

    test('clears the API key when apiKey is null', async () => {
      const res = await createApp('org-1').request('/api/team-settings/api-key', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: null }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, hasApiKey: false });

      const call = updateOrgCalls[0] as {
        body: { data: { anthropicApiKey: string | null } };
      };
      expect(call.body.data.anthropicApiKey).toBeNull();
    });
  });

  describe('PUT /api/team-settings/defaults', () => {
    test('updates org default settings', async () => {
      const res = await createApp('org-1').request('/api/team-settings/defaults', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          defaultModel: 'opus',
          defaultMode: 'local',
          defaultPermissionMode: 'plan',
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(updateOrgCalls).toHaveLength(1);

      const call = updateOrgCalls[0] as {
        body: {
          organizationId: string;
          data: { defaultModel: string; defaultMode: string; defaultPermissionMode: string };
        };
      };
      expect(call.body.organizationId).toBe('org-1');
      expect(call.body.data).toEqual({
        defaultModel: 'opus',
        defaultMode: 'local',
        defaultPermissionMode: 'plan',
      });
    });
  });

  describe('getOrgApiKey', () => {
    test('returns null for empty input', () => {
      expect(getOrgApiKey(null)).toBeNull();
      expect(getOrgApiKey(undefined)).toBeNull();
    });

    test('decrypts an encrypted org API key', () => {
      const encrypted = encrypt('sk-decrypt-me');
      expect(getOrgApiKey(encrypted)).toBe('sk-decrypt-me');
    });
  });
});
