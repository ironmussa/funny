/**
 * The `profile` and `settings` tRPC procedures (openspec adopt-trpc-browser-api,
 * task 5.1): per-user scoping, validation, the admin gate on SMTP, the project
 * gate on agent-profile bindings, and parity with the REST profile routes,
 * which serve the same port. The REST settings routes are gone (task 6.1).
 */

import { afterAll, mock } from 'bun:test';

import * as realNodemailerModule from 'nodemailer';

import { mockCoreGitRepoChecks, snapshotModule } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

const sendMailCalls: Array<Record<string, unknown>> = [];
const createTransportCalls: Array<Record<string, unknown>> = [];

// mock.module is process-global; put the real module back once this file finishes.
const realNodemailer = snapshotModule(realNodemailerModule);
mock.module('nodemailer', () => ({
  createTransport: (opts: Record<string, unknown>) => {
    createTransportCalls.push(opts);
    return {
      sendMail: async (opts: Record<string, unknown>) => {
        sendMailCalls.push(opts);
      },
    };
  },
}));
afterAll(() => {
  mock.module('nodemailer', () => realNodemailer);
});

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject } from '../helpers/test-db.js';

type Role = 'user' | 'admin';

const headersFor = (userId: string, role: Role) => ({
  'X-Test-User-Id': userId,
  'X-Test-User-Role': role,
  'Content-Type': 'application/json',
});

const claudeProfile = (name: string, configDir: string) => ({
  name,
  provider: 'claude',
  config: { claude: { configDir } },
});

describe('profile and settings tRPC procedures', () => {
  let t: TestApp;

  const query = async (userId: string, path: string, input?: unknown, role: Role = 'user') => {
    const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await t.app.request(`/api/trpc/${path}${qs}`, {
      headers: headersFor(userId, role),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const mutate = async (userId: string, path: string, input?: unknown, role: Role = 'user') => {
    const res = await t.app.request(`/api/trpc/${path}`, {
      method: 'POST',
      headers: headersFor(userId, role),
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    sendMailCalls.length = 0;
    createTransportCalls.length = 0;
  });

  describe('profile', () => {
    test('a user without a saved profile reads the defaults', async () => {
      const res = await query('user-1', 'profile.get');
      expect(res.status).toBe(200);
      expect(res.body.result.data).toMatchObject({
        userId: 'user-1',
        setupCompleted: false,
        gitName: null,
      });
    });

    test('update saves the caller’s profile only, and never returns secrets', async () => {
      const res = await mutate('user-1', 'profile.update', {
        gitName: 'Ada',
        githubToken: 'ghp_secret',
        setupCompleted: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.result.data).toMatchObject({
        gitName: 'Ada',
        hasGithubToken: true,
        setupCompleted: true,
      });
      expect(JSON.stringify(res.body)).not.toContain('ghp_secret');

      expect((await query('user-1', 'profile.setupCompleted')).body.result.data).toEqual({
        setupCompleted: true,
      });
      expect((await query('user-2', 'profile.get')).body.result.data.gitName).toBeNull();
    });

    test('update validates the body', async () => {
      const res = await mutate('user-1', 'profile.update', { setupCompleted: 'yes' });
      expect(res.status).toBe(400);
    });

    test('the runner invite token is stable until rotated', async () => {
      const first = (await query('user-1', 'profile.runnerInviteToken')).body.result.data.token;
      expect((await query('user-1', 'profile.runnerInviteToken')).body.result.data.token).toBe(
        first,
      );
      const rotated = (await mutate('user-1', 'profile.rotateRunnerInviteToken')).body.result.data
        .token;
      expect(rotated).not.toBe(first);
    });

    test('a transcribe token without an AssemblyAI key answers 400', async () => {
      const res = await query('user-1', 'profile.transcribeToken');
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('AssemblyAI API key not configured');
    });
  });

  describe('agent execution profiles', () => {
    test('create, list, update and delete are scoped to the caller', async () => {
      const created = await mutate(
        'user-1',
        'settings.createAgentProfile',
        claudeProfile('Work', '/home/u1/.claude-work'),
      );
      expect(created.status).toBe(200);
      const id = created.body.result.data.id;

      expect(
        (await query('user-1', 'settings.listAgentProfiles')).body.result.data.profiles,
      ).toHaveLength(1);
      expect(
        (await query('user-2', 'settings.listAgentProfiles')).body.result.data.profiles,
      ).toHaveLength(0);

      const renamed = await mutate('user-1', 'settings.updateAgentProfile', {
        id,
        data: { name: 'Renamed' },
      });
      expect(renamed.body.result.data.name).toBe('Renamed');

      expect(
        (await mutate('user-2', 'settings.updateAgentProfile', { id, data: { name: 'x' } })).status,
      ).toBe(404);
      expect((await mutate('user-2', 'settings.deleteAgentProfile', { id })).status).toBe(404);
      expect(
        (await mutate('user-1', 'settings.deleteAgentProfile', { id })).body.result.data,
      ).toEqual({ ok: true });
    });

    test('a project binding needs access to the project: 404 before validation', async () => {
      seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/tmp/p1' });

      const stranger = await query('user-2', 'settings.getProjectBinding', { projectId: 'p1' });
      expect(stranger.status).toBe(404);
      expect(stranger.body.error.message).toBe('Project not found');

      const badInput = await mutate('user-2', 'settings.setProjectBinding', {
        projectId: 'p1',
        profileId: 42,
      });
      expect(badInput.status).toBe(404);

      const profile = await mutate(
        'user-1',
        'settings.createAgentProfile',
        claudeProfile('Client', '/home/u1/.claude-client'),
      );
      const set = await mutate('user-1', 'settings.setProjectBinding', {
        projectId: 'p1',
        profileId: profile.body.result.data.id,
      });
      expect(set.status).toBe(200);
      expect(set.body.result.data.profile.name).toBe('Client');
      expect(
        (await query('user-1', 'settings.getProjectBinding', { projectId: 'p1' })).body.result.data
          .profile.name,
      ).toBe('Client');

      const cleared = await mutate('user-1', 'settings.setProjectBinding', {
        projectId: 'p1',
        profileId: null,
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.result.data.profile).toBeNull();
    });

    test('binding another user’s profile to your project answers 404', async () => {
      seedProject(t.db as any, { id: 'p2', userId: 'user-1', path: '/tmp/p2' });
      const foreign = await mutate(
        'user-2',
        'settings.createAgentProfile',
        claudeProfile('Other', '/home/u2/.claude'),
      );
      const res = await mutate('user-1', 'settings.setProjectBinding', {
        projectId: 'p2',
        profileId: foreign.body.result.data.id,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('SMTP (admin only)', () => {
    const smtp = { host: 'smtp.x', port: '587', user: 'u', pass: 'secret', from: 'a@x.test' };

    test('a non-admin is refused 403 on every SMTP procedure', async () => {
      expect((await query('user-1', 'settings.getSmtp')).status).toBe(403);
      expect((await mutate('user-1', 'settings.saveSmtp', smtp)).status).toBe(403);
      const test = await mutate('user-1', 'settings.testSmtp');
      expect(test.status).toBe(403);
      expect(test.body.error.message).toBe('Forbidden: admin required');
      expect(sendMailCalls).toEqual([]);
    });

    test('an admin saves, reads (without the password) and tests the settings', async () => {
      expect((await mutate('admin-1', 'settings.saveSmtp', smtp, 'admin')).status).toBe(200);

      const read = await query('admin-1', 'settings.getSmtp', undefined, 'admin');
      expect(read.body.result.data).toMatchObject({
        host: 'smtp.x',
        hasPassword: true,
        source: 'database',
        configured: true,
      });
      expect(JSON.stringify(read.body)).not.toContain('secret');

      const sent = await mutate('admin-1', 'settings.testSmtp', undefined, 'admin');
      expect(sent.body.result.data).toEqual({ ok: true, sentTo: 'a@x.test' });
      expect(sendMailCalls).toHaveLength(1);
      expect(sendMailCalls[0]?.subject).toBe('Funny SMTP Test');
      // Nodemailer must never read local files or fetch URLs named in a message.
      expect(createTransportCalls[0]?.disableFileAccess).toBe(true);
      expect(createTransportCalls[0]?.disableUrlAccess).toBe(true);
      expect(sendMailCalls[0]?.disableFileAccess).toBe(true);
      expect(sendMailCalls[0]?.disableUrlAccess).toBe(true);
    });

    test('defaults before anything is saved; testing then answers 400', async () => {
      const read = await query('admin-1', 'settings.getSmtp', undefined, 'admin');
      expect(read.body.result.data).toMatchObject({
        source: 'none',
        configured: false,
        hasPassword: false,
      });
      const sent = await mutate('admin-1', 'settings.testSmtp', undefined, 'admin');
      expect(sent.status).toBe(400);
      expect(sent.body.error.message).toBe('SMTP not configured');
      expect(sendMailCalls).toEqual([]);
    });

    test('saving without a password keeps the stored one', async () => {
      await mutate('admin-1', 'settings.saveSmtp', smtp, 'admin');
      const { pass: _pass, ...withoutPassword } = smtp;
      await mutate('admin-1', 'settings.saveSmtp', { ...withoutPassword, host: 'smtp.y' }, 'admin');
      const read = await query('admin-1', 'settings.getSmtp', undefined, 'admin');
      expect(read.body.result.data).toMatchObject({ host: 'smtp.y', hasPassword: true });
    });
  });

  describe('parity with the REST profile routes', () => {
    test('reads return the same data on both paths', async () => {
      await mutate('user-1', 'profile.update', { gitName: 'Ada' });

      const rest = t.requestAs('user-1');
      const pairs: Array<[string, string]> = [
        ['/api/profile', 'profile.get'],
        ['/api/profile/setup-completed', 'profile.setupCompleted'],
        ['/api/profile/runner-invite-token', 'profile.runnerInviteToken'],
      ];
      for (const [restPath, procedure] of pairs) {
        const restRes = await rest.get(restPath);
        const trpcRes = await query('user-1', procedure);
        expect(trpcRes.status).toBe(restRes.status);
        expect(trpcRes.body.result.data).toEqual(await restRes.json());
      }
    });

    test('failures carry the same status and message on both paths', async () => {
      const rest = await t.requestAs('user-1').get('/api/profile/transcribe-token');
      const trpc = await query('user-1', 'profile.transcribeToken');
      expect(trpc.status).toBe(rest.status);
      expect(trpc.body.error.message).toBe(((await rest.json()) as any).error);
    });
  });
});
