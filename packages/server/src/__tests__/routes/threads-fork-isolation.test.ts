/**
 * Fork authorization + runner isolation against the REAL runner resolution
 * (no resolver mocks). Complements `threads-runner-proxy.test.ts`, which pins
 * the HTTP contract with the resolver stubbed out.
 *
 * Covered here: a pinned project never falls back to another runner, another
 * user's online runner is never selected, org membership and the site-admin
 * role never stand in for ownership, and a foreign scratch thread stays hidden.
 */
import { describe, test, expect, beforeAll, beforeEach, mock, spyOn, afterEach } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import type { RunnerRequest } from '../../services/runner-ports.js';
import { __resetRunnerScopeCache, setProjectDedicatedRunner } from '../../services/runner-scope.js';
import * as threadRegistry from '../../services/thread-registry.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  seedOrgMember,
  seedProject,
  seedRunner,
  seedTeamProject,
  seedThread,
} from '../helpers/test-db.js';

const RUNNER_OWNERS: Record<string, string> = {
  'u1-general': 'user-1',
  'u1-dedicated': 'user-1',
  'u2-general': 'user-2',
};

/** Runners currently reachable; each test sets its own topology. */
const online = new Set<string>();

const tunnelFetch = mock(async (_runnerId: string, _request: RunnerRequest) => ({
  status: 201,
  headers: {},
  body: JSON.stringify({ id: 't-forked', title: 'Forked', mode: 'local' }),
}));

describe('Thread fork — authorization and runner isolation', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      runnerPresence: {
        isAvailable: (id) => online.has(id),
        userHasAvailableRunner: (userId) => [...online].some((id) => RUNNER_OWNERS[id] === userId),
        userIdForRunner: (id) => RUNNER_OWNERS[id] ?? null,
        availableRunnerCount: () => online.size,
      },
      runnerRequests: { isAvailable: (id) => online.has(id), request: tunnelFetch },
    });
  });

  beforeEach(() => {
    t.cleanup();
    __resetRunnerScopeCache();
    online.clear();
    tunnelFetch.mockClear();
    spyOn(threadRegistry, 'registerThread').mockResolvedValue(undefined as any);
    for (const [id, userId] of Object.entries(RUNNER_OWNERS)) {
      seedRunner(t.db as any, {
        id,
        userId,
        token: `tok-${id}`,
        hostname: id,
        role: id.endsWith('dedicated') ? 'dedicated' : 'general',
      });
    }
  });

  afterEach(() => {
    mock.restore();
  });

  function seedSource(opts: { owner?: string; organizationId?: string } = {}) {
    const owner = opts.owner ?? 'user-1';
    seedProject(t.db as any, {
      id: 'p1',
      userId: owner,
      path: '/a',
      ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
    });
    seedThread(t.db as any, { id: 't1', projectId: 'p1', userId: owner, title: 'Source' });
  }

  const runnersCalled = () => tunnelFetch.mock.calls.map((call) => call[0]);

  for (const variant of ['fork', 'fork-and-rewind'] as const) {
    describe(variant, () => {
      test('pinned project with its dedicated runner offline → 502, no fallback', async () => {
        seedSource();
        expect((await setProjectDedicatedRunner('p1', 'user-1', 'u1-dedicated')).ok).toBe(true);
        online.add('u1-general');

        const res = await t.requestAs('user-1').post(`/api/threads/t1/${variant}`, {});
        expect(res.status).toBe(502);
        // runner-request-isolation: the pinned outage is reported as such, not as a generic miss.
        expect((await res.json()).code).toBe('project-runner-offline');
        expect(tunnelFetch).not.toHaveBeenCalled();
        expect(threadRegistry.registerThread).not.toHaveBeenCalled();
      });

      test('pinned project routes only to its dedicated runner', async () => {
        seedSource();
        await setProjectDedicatedRunner('p1', 'user-1', 'u1-dedicated');
        online.add('u1-general').add('u1-dedicated');

        const res = await t.requestAs('user-1').post(`/api/threads/t1/${variant}`, {});
        expect(res.status).toBe(201);
        expect(runnersCalled()).toEqual(['u1-dedicated']);
      });

      test("another user's online runner is never selected", async () => {
        seedSource();
        online.add('u2-general');

        const res = await t.requestAs('user-1').post(`/api/threads/t1/${variant}`, {});
        expect(res.status).toBe(502);
        expect(tunnelFetch).not.toHaveBeenCalled();
      });

      test('the owner forks on their own runner', async () => {
        seedSource();
        online.add('u1-general').add('u2-general');

        const res = await t.requestAs('user-1').post(`/api/threads/t1/${variant}`, {});
        expect(res.status).toBe(201);
        expect(runnersCalled()).toEqual(['u1-general']);
      });

      for (const role of ['owner', 'admin', 'member']) {
        test(`org ${role} of the project's org cannot fork a colleague's thread`, async () => {
          seedSource({ organizationId: 'org-1' });
          seedTeamProject(t.db as any, { teamId: 'org-1', projectId: 'p1' });
          seedOrgMember(t.db as any, { organizationId: 'org-1', userId: 'user-1', role: 'owner' });
          seedOrgMember(t.db as any, { organizationId: 'org-1', userId: 'user-2', role });
          online.add('u1-general').add('u2-general');

          const res = await t
            .requestAs('user-2', 'user', { orgId: 'org-1' })
            .post(`/api/threads/t1/${variant}`, {});
          expect(res.status).toBe(404);
          expect(tunnelFetch).not.toHaveBeenCalled();
        });
      }

      test('site admin role does not stand in for ownership', async () => {
        seedSource();
        online.add('u1-general').add('u2-general');

        const res = await t.requestAs('user-2', 'admin').post(`/api/threads/t1/${variant}`, {});
        expect(res.status).toBe(404);
        expect(tunnelFetch).not.toHaveBeenCalled();
      });

      test('a foreign scratch thread is hidden (404, not 403)', async () => {
        seedThread(
          t.db as any,
          {
            id: 't1',
            projectId: null as any,
            userId: 'user-1',
            title: 'Scratch',
            isScratch: 1,
          } as any,
        );
        online.add('u1-general').add('u2-general');

        const res = await t.requestAs('user-2').post(`/api/threads/t1/${variant}`, {});
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Thread not found' });
        expect(tunnelFetch).not.toHaveBeenCalled();
      });
    });
  }
});
