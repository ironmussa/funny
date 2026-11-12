/**
 * The `runners` and `projectRunners` tRPC procedures (openspec
 * adopt-trpc-browser-api, task 5.6): a user reaches only their own runners and
 * projects (404 for anyone else's), an admin every runner, enrollment approval
 * binds the runner to the caller, and a project runner change made over tRPC
 * stops the agents of the runner that lost access, signed as the project owner.
 */
import { mockCoreGitRepoChecks } from '../helpers/module-mocks.js';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

mockCoreGitRepoChecks();

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { __resetRunnerScopeCache, canRunnerAccessProject } from '../../services/runner-scope.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedRunner, seedThread } from '../helpers/test-db.js';

describe('runners over tRPC', () => {
  let t: TestApp;
  const sent: Array<{ runnerId: string; path: string; headers: Record<string, string> }> = [];

  const headersFor = (userId: string, role: 'user' | 'admin' = 'user') => ({
    'X-Test-User-Id': userId,
    'X-Test-User-Role': role,
    'Content-Type': 'application/json',
  });

  const query = async (userId: string, path: string, input?: unknown, role?: 'admin') => {
    const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await t.app.request(`/api/trpc/${path}${qs}`, {
      headers: headersFor(userId, role),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  const mutate = async (userId: string, path: string, input: unknown, role?: 'admin') => {
    const res = await t.app.request(`/api/trpc/${path}`, {
      method: 'POST',
      headers: headersFor(userId, role),
      body: JSON.stringify(input),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  beforeAll(async () => {
    t = await createTestApp({
      runnerRequests: {
        isAvailable: () => true,
        request: async (
          runnerId: string,
          req: { path: string; headers: Record<string, string> },
        ) => {
          sent.push({ runnerId, path: req.path, headers: req.headers });
          return { status: 200, headers: {}, body: '{}' };
        },
      } as any,
    });
  });

  beforeEach(() => {
    t.cleanup();
    __resetRunnerScopeCache();
    sent.length = 0;
    seedProject(t.db as any, { id: 'px', userId: 'alice' });
    seedRunner(t.db as any, { id: 'laptop', userId: 'alice', token: 'tl', hostname: 'l' });
    seedRunner(t.db as any, {
      id: 'rx',
      userId: 'alice',
      token: 'tx',
      hostname: 'rx',
      role: 'dedicated',
    });
    seedRunner(t.db as any, { id: 'bob-r', userId: 'bob', token: 'tb', hostname: 'b' });
  });

  describe('runners', () => {
    test('a user lists their own runners, an admin every runner, like REST', async () => {
      const own = await query('alice', 'runners.list');
      expect(own.body.result.data.runners.map((r: any) => r.runnerId).sort()).toEqual([
        'laptop',
        'rx',
      ]);
      const rest = await t.requestAs('alice').get('/api/runners');
      expect(own.body.result.data).toEqual(await rest.json());

      const all = await query('root', 'runners.list', undefined, 'admin');
      expect(all.body.result.data.runners).toHaveLength(3);
    });

    test("someone else's runner answers 404 for remove, assign and unassign", async () => {
      expect((await mutate('alice', 'runners.remove', { runnerId: 'bob-r' })).status).toBe(404);
      const assign = await mutate('alice', 'runners.assignProject', {
        runnerId: 'bob-r',
        projectId: 'px',
        localPath: '/work/px',
      });
      expect(assign.status).toBe(404);
      expect(assign.body.error.message).toBe('Runner not found');
      expect(
        (await mutate('alice', 'runners.unassignProject', { runnerId: 'bob-r', projectId: 'px' }))
          .status,
      ).toBe(404);
      // Bob's runner is still there.
      expect((await query('bob', 'runners.list')).body.result.data.runners).toHaveLength(1);
    });

    test('the owner assigns a project to a runner and removes the runner', async () => {
      const assign = await mutate('alice', 'runners.assignProject', {
        runnerId: 'laptop',
        projectId: 'px',
        localPath: '/work/px',
      });
      expect(assign.status).toBe(200);
      expect(assign.body.result.data).toMatchObject({
        runnerId: 'laptop',
        projectId: 'px',
        localPath: '/work/px',
      });

      expect((await mutate('alice', 'runners.remove', { runnerId: 'laptop' })).status).toBe(200);
      const left = await query('alice', 'runners.list');
      expect(left.body.result.data.runners.map((r: any) => r.runnerId)).toEqual(['rx']);
    });

    test('an admin removes anyone’s runner', async () => {
      expect((await mutate('root', 'runners.remove', { runnerId: 'bob-r' }, 'admin')).status).toBe(
        200,
      );
      expect((await query('bob', 'runners.list')).body.result.data.runners).toEqual([]);
    });

    test('enrollment: an unknown code is 404; an approved one belongs to the approver', async () => {
      const unknown = await query('alice', 'runners.enrollment', { userCode: 'NOPE-NOPE' });
      expect(unknown.status).toBe(404);
      expect(unknown.body.error.message).toBe('Unknown or expired code');

      const enroll = await import('../../services/runner-enrollment-service.js');
      const started = await enroll.startEnrollment({ hostname: 'new-box', os: 'linux', ip: '::1' });
      const userCode = (started as any).userCode as string;

      const info = await query('alice', 'runners.enrollment', { userCode });
      expect(info.body.result.data.hostname).toBe('new-box');

      const approved = await mutate('alice', 'runners.approveEnrollment', { userCode });
      expect(approved.status).toBe(200);
      const runnerId = approved.body.result.data.runnerId;
      const mine = await query('alice', 'runners.list');
      expect(mine.body.result.data.runners.map((r: any) => r.runnerId)).toContain(runnerId);

      const again = await mutate('bob', 'runners.approveEnrollment', { userCode });
      expect(again.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('project runner settings', () => {
    test("someone else's project answers 404 for every procedure", async () => {
      expect((await query('bob', 'projectRunners.settings', { projectId: 'px' })).status).toBe(404);
      expect(
        (
          await mutate('bob', 'projectRunners.update', {
            projectId: 'px',
            data: { dedicatedRunnerId: 'bob-r' },
          })
        ).status,
      ).toBe(404);
      expect(
        (await mutate('bob', 'projectRunners.grant', { projectId: 'px', runnerId: 'bob-r' }))
          .status,
      ).toBe(404);
      // Nothing was stored.
      const after = await query('alice', 'projectRunners.settings', { projectId: 'px' });
      expect(after.body.result.data).toMatchObject({
        dedicatedRunnerId: null,
        grantedRunnerIds: [],
      });
    });

    test('pinning a dedicated runner stops the agents on the runner that lost access', async () => {
      seedThread(t.db as any, {
        id: 'running-on-laptop',
        projectId: 'px',
        userId: 'alice',
        status: 'running',
        runnerId: 'laptop',
      });
      const res = await mutate('alice', 'projectRunners.update', {
        projectId: 'px',
        data: { dedicatedRunnerId: 'rx' },
      });
      expect(res.status).toBe(200);
      expect(res.body.result.data.dedicatedRunnerId).toBe('rx');
      expect(await canRunnerAccessProject('laptop', 'px')).toBe(false);
      expect(sent.map((s) => [s.runnerId, s.path])).toEqual([
        ['laptop', '/api/threads/running-on-laptop/stop'],
      ]);
      expect(sent[0]!.headers['X-Forwarded-User']).toBe('alice');

      const settings = await query('alice', 'projectRunners.settings', { projectId: 'px' });
      const rest = await t.requestAs('alice').get('/api/projects/px/runner-settings');
      expect(settings.body.result.data).toEqual(await rest.json());
    });

    test("pinning or granting someone else's runner is 404", async () => {
      const pin = await mutate('alice', 'projectRunners.update', {
        projectId: 'px',
        data: { dedicatedRunnerId: 'bob-r' },
      });
      expect(pin.status).toBe(404);
      expect(pin.body.error.message).toBe('Runner not found');
      expect(
        (await mutate('alice', 'projectRunners.grant', { projectId: 'px', runnerId: 'bob-r' }))
          .status,
      ).toBe(404);
      // Nothing was stored.
      const after = await query('alice', 'projectRunners.settings', { projectId: 'px' });
      expect(after.body.result.data).toMatchObject({
        dedicatedRunnerId: null,
        grantedRunnerIds: [],
      });
    });

    test('grant then revoke a runner; the general runner is the caller’s own only', async () => {
      const granted = await mutate('alice', 'projectRunners.grant', {
        projectId: 'px',
        runnerId: 'rx',
      });
      expect(granted.body.result.data.grantedRunnerIds).toEqual(['rx']);
      const revoked = await mutate('alice', 'projectRunners.revoke', {
        projectId: 'px',
        runnerId: 'rx',
      });
      expect(revoked.body.result.data.grantedRunnerIds).toEqual([]);

      expect(
        (await mutate('alice', 'projectRunners.setGeneralRunner', { runnerId: 'laptop' })).body
          .result.data,
      ).toEqual({ generalRunnerId: 'laptop' });
      expect(
        (await mutate('alice', 'projectRunners.setGeneralRunner', { runnerId: 'bob-r' })).status,
      ).toBe(404);
    });
  });
});
