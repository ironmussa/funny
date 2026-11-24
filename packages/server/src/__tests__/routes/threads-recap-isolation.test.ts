/**
 * POST /api/threads/:id/recap is owner-only (openspec thread-recap, D1): it is
 * not on the steer allow-list, so a steer sharee, a view sharee and a stranger
 * get 404 and no runner is asked, while the owner's request reaches only the
 * owner's own runner (real runner resolution, no resolver mocks).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import type { RunnerRequest } from '../../services/runner-ports.js';
import { resetRunnerScopeCache } from '../../services/runner-scope.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedProject, seedRunner, seedThread } from '../helpers/test-db.js';

const RUNNER_OWNERS: Record<string, string> = {
  'u1-general': 'user-1',
  'u2-general': 'user-2',
  'u3-general': 'user-3',
};

const tunnelFetch = mock(async (_runnerId: string, _request: RunnerRequest) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ recap: 'The agent finished.', newestMessageId: 'm1' }),
}));

const body = { since: '2026-11-23T10:00:00.000Z', newestMessageId: 'm1', language: 'en' };

describe('POST /api/threads/:id/recap — owner only', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      runnerPresence: {
        isAvailable: async () => true,
        userHasAvailableRunner: async () => true,
        userIdForRunner: async (id) => RUNNER_OWNERS[id] ?? null,
        availableRunnerCount: async () => Object.keys(RUNNER_OWNERS).length,
      },
      runnerRequests: { isAvailable: async () => true, request: tunnelFetch },
    });
  });

  beforeEach(async () => {
    t.cleanup();
    resetRunnerScopeCache();
    tunnelFetch.mockClear();
    for (const [id, userId] of Object.entries(RUNNER_OWNERS)) {
      seedRunner(t.db, { id, userId, token: `tok-${id}`, hostname: id, role: 'general' });
    }
    seedProject(t.db, { id: 'p1', userId: 'user-1', path: '/a' });
    seedThread(t.db, { id: 't1', projectId: 'p1', userId: 'user-1', title: 'Owned' });
    const { repos } = await import('../../db/repos.js');
    await repos.threadShares().createShare({
      threadId: 't1',
      sharedWithUserId: 'user-2',
      sharedByUserId: 'user-1',
      level: 'steer',
    });
  });

  afterEach(() => {
    mock.restore();
  });

  test('the owner reaches only their own runner, signed as themselves', async () => {
    const res = await t.requestAs('user-1').post('/api/threads/t1/recap', body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recap: 'The agent finished.', newestMessageId: 'm1' });
    expect(tunnelFetch.mock.calls.map((call) => call[0])).toEqual(['u1-general']);
    const sent = tunnelFetch.mock.calls[0][1];
    expect(sent.path).toBe('/api/threads/t1/recap');
    expect(sent.headers['X-Forwarded-User']).toBe('user-1');
  });

  test('a steer sharee gets 404 and no runner request is sent', async () => {
    const res = await t.requestAs('user-2').post('/api/threads/t1/recap', body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Thread not found' });
    expect(tunnelFetch).not.toHaveBeenCalled();
  });

  test('a stranger gets 404 and no runner request is sent', async () => {
    const res = await t.requestAs('user-3').post('/api/threads/t1/recap', body);
    expect(res.status).toBe(404);
    expect(tunnelFetch).not.toHaveBeenCalled();
  });

  test('a missing thread gets 404 and no runner request is sent', async () => {
    const res = await t.requestAs('user-1').post('/api/threads/nope/recap', body);
    expect(res.status).toBe(404);
    expect(tunnelFetch).not.toHaveBeenCalled();
  });
});
