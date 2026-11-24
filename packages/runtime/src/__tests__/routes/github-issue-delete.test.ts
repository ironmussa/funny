import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import { Hono } from 'hono';

import type { HonoEnv } from '../../types/hono-env.js';

const graphql = vi.fn();
interface RecordedSpec {
  input: unknown;
}
interface RecordedOutcome {
  ok: boolean;
  effects?: unknown;
}
const recordActivity = vi.fn(async (_spec: RecordedSpec, _outcome: RecordedOutcome) => {});

mock.module('../../routes/github/helpers.js', () => ({
  githubGraphQL: (...args: unknown[]) => graphql(...args),
  githubRepoFor: async () => ({ owner: 'acme', repo: 'repo', token: 'tok' }),
}));
mock.module('../../services/activity-tracker.js', () => ({ recordActivity }));

const { issueDeleteRoutes } = await import('../../routes/github/issue-delete.js');

function app() {
  const a = new Hono<HonoEnv>();
  a.use('*', async (c, next) => {
    c.set('userId', 'u1');
    await next();
  });
  a.route('/', issueDeleteRoutes);
  return a;
}

const post = (body: unknown) =>
  app().request('/issues-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** GitHub answers: issue 404 does not exist, issue 403 is refused, the rest are deleted. */
function github() {
  graphql.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
    if (query.includes('deleteIssue')) {
      if (vars.id === 'I_403') throw new Error('Must be an admin to delete an issue');
      return { deleteIssue: { clientMutationId: null } };
    }
    const n = vars.number as number;
    return { repository: { issue: n === 404 ? null : { id: `I_${n}` } } };
  });
}

describe('POST /issues-delete', () => {
  beforeEach(() => {
    graphql.mockReset();
    recordActivity.mockClear();
    github();
  });

  test('deletes each issue and records one activity with what was deleted', async () => {
    const res = await post({ projectId: 'p1', issueNumbers: [1, 2, 2] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: [1, 2], failed: [] });
    expect(recordActivity).toHaveBeenCalledTimes(1);
    const [spec, outcome] = recordActivity.mock.calls[0]!;
    expect(spec.input).toEqual({ action: 'issue-delete', repo: 'acme/repo' });
    expect(outcome.ok).toBe(true);
    expect(outcome.effects).toEqual([
      { effect: 'issue-deleted', target: '#1' },
      { effect: 'issue-deleted', target: '#2' },
    ]);
  });

  test('an issue GitHub refuses is reported, the others are still deleted', async () => {
    const res = await post({ projectId: 'p1', issueNumbers: [403, 5, 404] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deleted: number[];
      failed: Array<{ issueNumber: number }>;
    };
    expect(body.deleted).toEqual([5]);
    expect(body.failed.map((f) => f.issueNumber)).toEqual([403, 404]);
  });

  test('when nothing is deleted the request fails with GitHub’s message', async () => {
    const res = await post({ projectId: 'p1', issueNumbers: [403] });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('admin');
  });

  test('refuses an empty or oversized list before calling GitHub', async () => {
    expect((await post({ projectId: 'p1', issueNumbers: [] })).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => i + 1);
    expect((await post({ projectId: 'p1', issueNumbers: many })).status).toBe(400);
    expect(graphql).not.toHaveBeenCalled();
  });
});
