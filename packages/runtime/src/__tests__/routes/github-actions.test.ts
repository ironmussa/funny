import { Hono } from 'hono';
import { ok } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The Actions tab routes: the run list (and the filters it forwards), a run's
 * jobs, the end of a failed job's log, and re-running failed jobs.
 */

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  getGithubToken: vi.fn(),
  getRemoteUrl: vi.fn(),
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: { getProject: mocks.getProject },
    profile: { getGithubToken: mocks.getGithubToken },
  }),
}));

vi.mock('@funny/core/git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@funny/core/git')>()),
  getRemoteUrl: mocks.getRemoteUrl,
  // The `gh auth token` fallback must never see the host's real gh CLI.
  execute: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 1 })),
}));

import { actionRoutes, extractFailureTail } from '../../routes/github/actions.js';
import { _resetGithubCache } from '../../routes/github/github-cache.js';
import type { HonoEnv } from '../../types/hono-env.js';

function app() {
  const a = new Hono<HonoEnv>();
  a.use('*', async (c, next) => {
    c.set('userId', 'u-1');
    c.set('organizationId', null);
    await next();
  });
  a.route('/gh', actionRoutes);
  return a;
}

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const RAW_RUN = {
  id: 11,
  name: 'CI',
  display_title: 'feat: thing',
  run_number: 42,
  run_attempt: 1,
  event: 'pull_request',
  status: 'waiting',
  conclusion: null,
  head_branch: 'feat/x',
  head_sha: 'abc123',
  html_url: 'https://github.com/acme/repo/actions/runs/11',
  actor: { login: 'alice', avatar_url: 'a.png', id: 9 },
  created_at: 'c',
  run_started_at: 's',
  updated_at: 'u',
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetGithubCache();
  vi.stubGlobal('fetch', fetchMock);
  mocks.getProject.mockResolvedValue({ id: 'p-1', userId: 'u-1', path: '/repo' });
  mocks.getRemoteUrl.mockResolvedValue(ok('https://github.com/acme/repo.git'));
  mocks.getGithubToken.mockResolvedValue('tok');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /actions/runs', () => {
  test('maps runs, forwards branch / status / paging, and reports more pages', async () => {
    fetchMock.mockResolvedValue(json({ total_count: 45, workflow_runs: [RAW_RUN] }));

    const res = await app().request(
      '/gh/actions/runs?projectId=p-1&branch=feat%2Fx&status=failure&page=1&per_page=30',
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      runs: [
        {
          id: 11,
          name: 'CI',
          display_title: 'feat: thing',
          run_number: 42,
          run_attempt: 1,
          event: 'pull_request',
          status: 'queued',
          conclusion: null,
          head_branch: 'feat/x',
          head_sha: 'abc123',
          html_url: 'https://github.com/acme/repo/actions/runs/11',
          actor: { login: 'alice', avatar_url: 'a.png' },
          created_at: 'c',
          run_started_at: 's',
          updated_at: 'u',
        },
      ],
      total_count: 45,
      hasMore: true,
    });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/repos/acme/repo/actions/runs');
    expect(url.searchParams.get('branch')).toBe('feat/x');
    expect(url.searchParams.get('status')).toBe('failure');
    expect(url.searchParams.get('per_page')).toBe('30');
  });

  test('refuses a status GitHub would not understand', async () => {
    const res = await app().request('/gh/actions/runs?projectId=p-1&status=open%26x%3D1');
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('answers 404 for a project the caller cannot see', async () => {
    mocks.getProject.mockResolvedValue(undefined);
    const res = await app().request('/gh/actions/runs?projectId=p-1');
    expect(res.status).toBe(404);
  });

  test('answers 502 when GitHub fails', async () => {
    fetchMock.mockResolvedValue(json({ message: 'boom' }, 500));
    const res = await app().request('/gh/actions/runs?projectId=p-1');
    expect(res.status).toBe(502);
  });
});

describe('GET /actions/jobs', () => {
  test('maps the latest attempt jobs and their steps', async () => {
    fetchMock.mockResolvedValue(
      json({
        jobs: [
          {
            id: 7,
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            html_url: 'h',
            started_at: 's',
            completed_at: 'e',
            steps: [
              { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' },
              { number: 2, name: 'Run tests', status: 'completed', conclusion: 'failure' },
            ],
          },
        ],
      }),
    );

    const res = await app().request('/gh/actions/jobs?projectId=p-1&runId=11');

    expect(res.status).toBe(200);
    const { jobs } = await res.json();
    expect(jobs[0]).toMatchObject({ id: 7, conclusion: 'failure' });
    expect(jobs[0].steps[1]).toEqual({
      number: 2,
      name: 'Run tests',
      status: 'completed',
      conclusion: 'failure',
      started_at: null,
      completed_at: null,
    });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/repos/acme/repo/actions/runs/11/jobs');
    expect(url.searchParams.get('filter')).toBe('latest');
  });

  test('reads every page of a run with more than 100 jobs', async () => {
    const job = (id: number) => ({ id, name: `job-${id}`, status: 'completed', steps: [] });
    fetchMock
      .mockResolvedValueOnce(json({ jobs: Array.from({ length: 100 }, (_, i) => job(i + 1)) }))
      .mockResolvedValueOnce(json({ jobs: [job(101)] }));

    const res = await app().request('/gh/actions/jobs?projectId=p-1&runId=11');

    expect(res.status).toBe(200);
    const { jobs } = await res.json();
    expect(jobs).toHaveLength(101);
    expect(jobs[100].id).toBe(101);
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('page')).toBe('2');
  });

  test('requires a run id', async () => {
    const res = await app().request('/gh/actions/jobs?projectId=p-1&runId=abc');
    expect(res.status).toBe(400);
  });
});

describe('GET /actions/job-log', () => {
  test('answers the readable end of the log', async () => {
    fetchMock.mockResolvedValue(
      new Response('2026-11-19T10:00:00.1234567Z hello\n2026-11-19T10:00:01.0Z ##[error]bad\n'),
    );
    const res = await app().request('/gh/actions/job-log?projectId=p-1&jobId=7');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lines: ['hello', '\x1b[31mError: bad\x1b[0m'],
      truncated: false,
    });
  });

  test('follows the redirect to the signed log URL without the token', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: 'https://logs.example/job7' } }),
      )
      .mockResolvedValueOnce(new Response('done\n'));
    const res = await app().request('/gh/actions/job-log?projectId=p-1&jobId=7');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lines: ['done'], truncated: false });
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
    expect(fetchMock.mock.calls[1]).toEqual(['https://logs.example/job7']);
  });

  test('answers 404 when GitHub has no log (running or expired)', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 410 }));
    const res = await app().request('/gh/actions/job-log?projectId=p-1&jobId=7');
    expect(res.status).toBe(404);
  });
});

describe('POST /actions/rerun-failed', () => {
  const post = (body: unknown) =>
    app().request('/gh/actions/rerun-failed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('asks GitHub to re-run the failed jobs', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    const res = await post({ projectId: 'p-1', runId: 11 });
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'https://api.github.com/repos/acme/repo/actions/runs/11/rerun-failed-jobs',
    );
    expect(init?.method).toBe('POST');
  });

  test("passes GitHub's 403 through when the token cannot write Actions", async () => {
    fetchMock.mockResolvedValue(json({ message: 'Resource not accessible by integration' }, 403));
    const res = await post({ projectId: 'p-1', runId: 11 });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Resource not accessible by integration' });
  });

  test('requires a run id', async () => {
    const res = await post({ projectId: 'p-1' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('extractFailureTail', () => {
  test('ends a few lines after the last error, dropping post-job cleanup', () => {
    const raw = [
      '##[group]Run bun test',
      'running',
      '##[endgroup]',
      '##[error]Process completed with exit code 1.',
      'a',
      'b',
      'c',
      'Post job cleanup.',
      'more cleanup',
    ].join('\n');
    expect(extractFailureTail(raw).lines).toEqual([
      '▸ Run bun test',
      'running',
      '\x1b[31mError: Process completed with exit code 1.\x1b[0m',
      'a',
      'b',
      'c',
    ]);
  });

  test('keeps only the last lines and says it cut', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    expect(extractFailureTail(raw, 3)).toEqual({
      lines: ['line 7', 'line 8', 'line 9'],
      truncated: true,
    });
  });
});
