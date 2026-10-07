/**
 * Project runner binding settings API (project-runner-binding).
 */
process.env.RUNNER_AUTH_SECRET = 'test-secret';

import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';

import { stopProjectSessionsOnRunners } from '../../routes/project-runner-settings.js';
import { __resetRunnerScopeCache, canRunnerAccessProject } from '../../services/runner-scope.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedRunner, seedThread } from '../helpers/test-db.js';

describe('Project runner settings routes', () => {
  let t: TestApp;
  const stopped: string[] = [];
  const sent: Array<{ runnerId: string; headers: Record<string, string> }> = [];

  beforeAll(async () => {
    t = await createTestApp({
      runnerRequests: {
        isAvailable: () => true,
        request: async (
          runnerId: string,
          req: { path: string; headers: Record<string, string> },
        ) => {
          stopped.push(req.path);
          sent.push({ runnerId, headers: req.headers });
          return { status: 200, headers: {}, body: '{}' };
        },
      } as any,
    });
  });

  /** True when the headers carry a valid signed forwarded identity for `userId`. */
  const signedFor = (userId: string, headers: Record<string, string>) =>
    verifyForwardedIdentity(
      { userId, role: 'user', orgId: null, orgName: null },
      'test-secret',
      headers[SIGNATURE_HEADER],
      headers[TIMESTAMP_HEADER],
      headers[NONCE_HEADER],
    );

  beforeEach(() => {
    t.cleanup();
    __resetRunnerScopeCache();
    stopped.length = 0;
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

  test('owner pins a dedicated runner; the general runner loses access and its agents stop', async () => {
    seedThread(t.db as any, {
      id: 'running-on-laptop',
      projectId: 'px',
      userId: 'alice',
      status: 'running',
      runnerId: 'laptop',
    });
    const res = await t.requestAs('alice').put('/api/projects/px/runner-settings', {
      dedicatedRunnerId: 'rx',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).dedicatedRunnerId).toBe('rx');
    expect(await canRunnerAccessProject('laptop', 'px')).toBe(false);
    expect(stopped).toEqual(['/api/threads/running-on-laptop/stop']);
    // The stop is sent to the owner's revoked runner, signed as the project owner.
    expect(sent[0]!.runnerId).toBe('laptop');
    expect(sent[0]!.headers['X-Forwarded-User']).toBe('alice');
    expect(signedFor('alice', sent[0]!.headers)).toBe(true);

    const get = await t.requestAs('alice').get('/api/projects/px/runner-settings');
    const body = await get.json();
    expect(body.dedicatedRunnerId).toBe('rx');
    expect(body.runners.map((r: any) => r.runnerId).sort()).toEqual(['laptop', 'rx']);
  });

  test('stop-sessions skips a runner the project owner does not own', async () => {
    seedThread(t.db as any, {
      id: 'on-bobs-runner',
      projectId: 'px',
      userId: 'alice',
      status: 'running',
      runnerId: 'bob-r',
    });
    seedThread(t.db as any, {
      id: 'on-laptop',
      projectId: 'px',
      userId: 'alice',
      status: 'running',
      runnerId: 'laptop',
    });
    const requests = {
      isAvailable: () => true,
      request: async (runnerId: string, req: { path: string; headers: Record<string, string> }) => {
        stopped.push(req.path);
        sent.push({ runnerId, headers: req.headers });
        return { status: 200, headers: {}, body: '{}' };
      },
    } as any;
    await stopProjectSessionsOnRunners({ requests }, 'px', ['bob-r', 'laptop']);
    expect(stopped).toEqual(['/api/threads/on-laptop/stop']);
    expect(sent.map((entry) => entry.runnerId)).toEqual(['laptop']);
    expect(signedFor('alice', sent[0]!.headers)).toBe(true);
  });

  test("non-owners cannot read or change a project's runner binding", async () => {
    expect((await t.requestAs('bob').get('/api/projects/px/runner-settings')).status).toBe(404);
    expect(
      (
        await t
          .requestAs('bob')
          .put('/api/projects/px/runner-settings', { dedicatedRunnerId: null })
      ).status,
    ).toBe(404);
  });

  test("cannot pin or grant another user's runner", async () => {
    const pin = await t.requestAs('alice').put('/api/projects/px/runner-settings', {
      dedicatedRunnerId: 'bob-r',
    });
    expect(pin.status).toBe(404);
    expect((await t.requestAs('alice').post('/api/projects/px/runner-grants/bob-r')).status).toBe(
      404,
    );
  });

  test('grant and revoke an extra runner', async () => {
    await t.requestAs('alice').put('/api/projects/px/runner-settings', { dedicatedRunnerId: 'rx' });
    const granted = await t.requestAs('alice').post('/api/projects/px/runner-grants/laptop');
    expect((await granted.json()).grantedRunnerIds).toEqual(['laptop']);
    expect(await canRunnerAccessProject('laptop', 'px')).toBe(true);
    const revoked = await t.requestAs('alice').delete('/api/projects/px/runner-grants/laptop');
    expect((await revoked.json()).grantedRunnerIds).toEqual([]);
    expect(await canRunnerAccessProject('laptop', 'px')).toBe(false);
  });

  test('project GitHub token is stored but never returned', async () => {
    const res = await t.requestAs('alice').put('/api/projects/px/runner-settings', {
      githubToken: 'ghp_secret',
    });
    const body = await res.json();
    expect(body.hasGithubToken).toBe(true);
    expect(JSON.stringify(body)).not.toContain('ghp_secret');
  });

  test('designate the general runner', async () => {
    const res = await t.requestAs('alice').put('/api/projects/general-runner', {
      runnerId: 'laptop',
    });
    expect(res.status).toBe(200);
    const get = await t.requestAs('alice').get('/api/projects/px/runner-settings');
    expect((await get.json()).generalRunnerId).toBe('laptop');
    expect(
      (await t.requestAs('alice').put('/api/projects/general-runner', { runnerId: 'bob-r' }))
        .status,
    ).toBe(404);
  });
});
