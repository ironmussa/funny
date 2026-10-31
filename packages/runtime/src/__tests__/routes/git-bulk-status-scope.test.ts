import { Hono } from 'hono';
import { ok, okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listThreads: vi.fn(),
  getStatusSummary: vi.fn(),
  getCommittedBranchSummary: vi.fn(),
  getCurrentBranch: vi.fn(),
}));

vi.mock('@funny/core/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@funny/core/git')>();
  return {
    ...actual,
    getStatusSummary: mocks.getStatusSummary,
    getCommittedBranchSummary: mocks.getCommittedBranchSummary,
    getCurrentBranch: mocks.getCurrentBranch,
  };
});

vi.mock('../../services/thread-manager.js', () => ({ listThreads: mocks.listThreads }));
vi.mock('../../services/git-service.js', () => ({ resolveIdentity: vi.fn(async () => null) }));
vi.mock('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));
vi.mock('../../lib/telemetry.js', () => ({ startSpan: vi.fn(() => ({ end: vi.fn() })) }));
vi.mock('../../middleware/tracing.js', () => ({
  requestSpan: vi.fn(() => ({ end: vi.fn(), traceId: 't', spanId: 's' })),
}));
vi.mock('../../utils/route-helpers.js', () => ({
  requireProject: vi.fn(async () => ok({ id: 'p1', path: '/repo' })),
  requireThread: vi.fn(),
  steerFromContext: vi.fn(),
  isSteerGrantFor: vi.fn(),
}));
vi.mock('../../routes/git/helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/git/helpers.js')>();
  return {
    ...actual,
    getCachedPR: vi.fn(() => null),
    scheduleBackgroundFetch: vi.fn(() => false),
    schedulePRLookup: vi.fn(),
  };
});

import { statusRoutes } from '../../routes/git/status.js';
import { gitStatusCache } from '../../services/git-runtime-service.js';

const SUMMARY = {
  dirtyFileCount: 0,
  unpushedCommitCount: 0,
  unpulledCommitCount: 0,
  hasRemoteBranch: false,
  isMergedIntoBase: false,
  linesAdded: 0,
  linesDeleted: 0,
};

function thread(id: string, extra: Record<string, unknown> = {}) {
  return { id, projectId: 'p1', mode: 'local', branch: 'master', baseBranch: 'master', ...extra };
}

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('userId' as never, 'u1' as never);
  await next();
});
app.route('/', statusRoutes);

async function statusIds(url: string): Promise<string[]> {
  const res = await app.request(url);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { statuses: Array<{ threadId: string }> };
  return body.statuses.map((s) => s.threadId).sort();
}

describe('GET /status bulk thread scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitStatusCache.clear();
    mocks.listThreads.mockResolvedValue({
      threads: [
        thread('a'),
        thread('b'),
        thread('wt', { mode: 'worktree', worktreePath: '/wt', branch: 'feat' }),
        thread('bg', { branch: 'other' }),
      ],
    });
    mocks.getCurrentBranch.mockReturnValue(okAsync('master'));
    mocks.getStatusSummary.mockReturnValue(okAsync(SUMMARY));
    mocks.getCommittedBranchSummary.mockReturnValue(okAsync(SUMMARY));
  });

  test('without threadIds computes every thread of the project', async () => {
    expect(await statusIds('/status?projectId=p1')).toEqual(['a', 'b', 'bg', 'wt']);
    expect(mocks.getCommittedBranchSummary).toHaveBeenCalledTimes(1);
  });

  test('with threadIds computes only those threads', async () => {
    expect(await statusIds('/status?projectId=p1&threadIds=a,b')).toEqual(['a', 'b']);
    // The worktree and the off-branch thread were not requested: no git work for them.
    expect(mocks.getStatusSummary).toHaveBeenCalledTimes(1);
    expect(mocks.getStatusSummary).toHaveBeenCalledWith('/repo', 'master', '/repo');
    expect(mocks.getCommittedBranchSummary).not.toHaveBeenCalled();
  });

  test('a cached scoped response is not served for a different scope', async () => {
    await statusIds('/status?projectId=p1&threadIds=a');
    expect(await statusIds('/status?projectId=p1')).toEqual(['a', 'b', 'bg', 'wt']);
    expect(await statusIds('/status?projectId=p1&threadIds=a')).toEqual(['a']);
  });
});
