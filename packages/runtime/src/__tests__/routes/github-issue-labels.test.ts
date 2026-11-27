import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import { Hono } from 'hono';

import type { HonoEnv } from '../../types/hono-env.js';

const apiFetch = vi.fn();
interface RecordedSpec {
  input: unknown;
}
interface RecordedOutcome {
  ok: boolean;
  effects?: unknown;
}
const recordActivity = vi.fn(async (_spec: RecordedSpec, _outcome: RecordedOutcome) => {});

mock.module('../../routes/github/helpers.js', () => ({
  githubApiFetch: (...args: unknown[]) => apiFetch(...args),
  githubRepoFor: async () => ({ owner: 'acme', repo: 'repo', token: 'tok' }),
}));
mock.module('../../services/activity-tracker.js', () => ({ recordActivity }));

const { issueLabelsRoutes } = await import('../../routes/github/issue-labels.js');

function app() {
  const a = new Hono<HonoEnv>();
  a.use('*', async (c, next) => {
    c.set('userId', 'u1');
    await next();
  });
  a.route('/', issueLabelsRoutes);
  return a;
}

const post = (body: unknown) =>
  app().request('/issues-labels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** GitHub answers: issue 403 is refused, the rest are labelled. */
function github() {
  apiFetch.mockImplementation(async (path: string) =>
    path.includes('/issues/403/')
      ? Response.json({ message: 'Resource not accessible' }, { status: 403 })
      : Response.json([{ name: 'lane:payments' }]),
  );
}

describe('POST /issues-labels', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    recordActivity.mockClear();
    github();
  });

  test('adds the labels to each issue and records one activity', async () => {
    const res = await post({ projectId: 'p1', issueNumbers: [1, 2, 2], labels: ['lane:payments'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ labeled: [1, 2], failed: [] });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    const [path, token, init] = apiFetch.mock.calls[0]!;
    expect(path).toBe('/repos/acme/repo/issues/1/labels');
    expect(token).toBe('tok');
    expect(JSON.parse(init.body)).toEqual({ labels: ['lane:payments'] });
    const [spec, outcome] = recordActivity.mock.calls[0]!;
    expect(spec.input).toEqual({ action: 'issue-label', repo: 'acme/repo' });
    expect(outcome.effects).toEqual([
      { effect: 'issue-labeled', target: '#1' },
      { effect: 'issue-labeled', target: '#2' },
    ]);
  });

  test('an issue GitHub refuses is reported, the others are still labelled', async () => {
    const res = await post({ projectId: 'p1', issueNumbers: [403, 5], labels: ['lane:a'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { labeled: number[]; failed: Array<{ message: string }> };
    expect(body.labeled).toEqual([5]);
    expect(body.failed[0]!.message).toContain('Resource not accessible');
  });

  test('when nothing is labelled the request fails with GitHub’s message', async () => {
    const res = await post({ projectId: 'p1', issueNumbers: [403], labels: ['lane:a'] });
    expect(res.status).toBe(502);
  });

  test('refuses no labels or no issues before calling GitHub', async () => {
    expect((await post({ projectId: 'p1', issueNumbers: [1], labels: [] })).status).toBe(400);
    expect((await post({ projectId: 'p1', issueNumbers: [], labels: ['x'] })).status).toBe(400);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
