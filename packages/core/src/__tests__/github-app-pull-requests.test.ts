import { errAsync, okAsync } from 'neverthrow';
import { describe, expect, test } from 'vitest';

import { createPullRequestCi, createRepoGithub } from '../github-app/index.js';

/** A fetch that answers GitHub paths from a table; records what was called. */
function fakeGithub(routes: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; auth: string | null }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url.replace('https://api.github.com', '');
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ method, path, auth });
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response('not found', { status: 404 });
    const body = routes[key];
    return typeof body === 'string'
      ? new Response(body, { status: 200 })
      : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const pull = { node_id: 'PR_1', mergeable: true, mergeable_state: 'clean', head: { sha: 'abc' } };

const ciFor = (routes: Record<string, unknown>) => {
  const gh = fakeGithub(routes);
  const ci = createPullRequestCi(
    createRepoGithub({ tokenFor: () => okAsync('tok-1'), fetch: gh.fetchImpl }),
  );
  return { ci, calls: gh.calls };
};

describe('pull request CI over GitHub (shared by the factory and the server)', () => {
  test('required checks: only the named ones count, and a missing one is pending', async () => {
    const routes = (runs: unknown[]) => ({
      'GET /repos/o/r/pulls/7': pull,
      'GET /repos/o/r/commits/abc/check-runs?per_page=100': { check_runs: runs },
      'GET /repos/o/r/commits/abc/status': {
        statuses: [{ context: 'deploy-preview', state: 'pending', description: null }],
      },
    });
    const build = { id: 1, name: 'build', status: 'completed', conclusion: 'success' };
    const lint = { id: 2, name: 'lint', status: 'completed', conclusion: 'failure' };

    // A failing `lint` and a pending preview do not matter when only `build` is required.
    const onlyBuild = ciFor(routes([build, lint]));
    expect((await onlyBuild.ci.ciState('o/r', 7, ['build']))._unsafeUnwrap()).toEqual({
      kind: 'green',
    });
    // Without the filter the pending preview keeps it pending.
    expect((await onlyBuild.ci.ciState('o/r', 7))._unsafeUnwrap()).toEqual({ kind: 'pending' });
    // A required check that has not reported yet is pending, not green.
    const notYet = ciFor(routes([lint]));
    expect((await notYet.ci.ciState('o/r', 7, ['build']))._unsafeUnwrap()).toEqual({
      kind: 'pending',
    });
    // But a required check that already failed is red even while another has not reported.
    const redFirst = ciFor({
      ...routes([lint]),
      'GET /repos/o/r/commits/abc/status': { statuses: [] },
    });
    const state = (await redFirst.ci.ciState('o/r', 7, ['lint', 'e2e']))._unsafeUnwrap();
    expect(state.kind).toBe('failing');
  });

  test('green when every check run completed successfully, with the given token', async () => {
    const { ci, calls } = ciFor({
      'GET /repos/o/r/pulls/7': pull,
      'GET /repos/o/r/commits/abc/check-runs?per_page=100': {
        check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }],
      },
      'GET /repos/o/r/commits/abc/status': { statuses: [] },
    });
    expect((await ci.ciState('o/r', 7))._unsafeUnwrap()).toEqual({ kind: 'green' });
    expect(calls.every((c) => c.auth === 'token tok-1')).toBe(true);
  });

  test('failing with the end of a failed Actions job log', async () => {
    const { ci } = ciFor({
      'GET /repos/o/r/pulls/7': pull,
      'GET /repos/o/r/commits/abc/check-runs?per_page=100': {
        check_runs: [
          {
            id: 9,
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            app: { slug: 'github-actions' },
          },
        ],
      },
      'GET /repos/o/r/commits/abc/status': { statuses: [] },
      'GET /repos/o/r/actions/jobs/9/logs': 'FAIL src/x.test.ts',
    });
    expect((await ci.ciState('o/r', 7))._unsafeUnwrap()).toEqual({
      kind: 'failing',
      checks: [{ name: 'test', conclusion: 'failure', excerpt: 'FAIL src/x.test.ts' }],
    });
  });

  // The 0security status of PR #342: its service could not run ("add a card").
  // A fix step cannot change that, so it is `blocked`, not `failing`.
  const blockedRoutes = (runs: unknown[]) => ({
    'GET /repos/o/r/pulls/7': pull,
    'GET /repos/o/r/commits/abc/check-runs?per_page=100': { check_runs: runs },
    'GET /repos/o/r/commits/abc/status': {
      statuses: [
        {
          context: '0security - PR Security',
          state: 'error',
          description: 'Review not started: add a card',
        },
      ],
    },
  });

  test('blocked when the only failure is a status whose service could not run', async () => {
    const build = { id: 1, name: 'build', status: 'completed', conclusion: 'success' };
    const { ci } = ciFor(blockedRoutes([build]));
    expect((await ci.ciState('o/r', 7))._unsafeUnwrap()).toEqual({
      kind: 'blocked',
      checks: [
        {
          name: '0security - PR Security',
          conclusion: 'error',
          excerpt: 'Review not started: add a card',
        },
      ],
    });
  });

  test('blocked when a check run waits for someone (action_required)', async () => {
    const gate = { id: 3, name: 'deploy-gate', status: 'completed', conclusion: 'action_required' };
    const { ci } = ciFor({
      ...blockedRoutes([gate]),
      'GET /repos/o/r/commits/abc/status': { statuses: [] },
    });
    expect((await ci.ciState('o/r', 7))._unsafeUnwrap()).toMatchObject({
      kind: 'blocked',
      checks: [{ name: 'deploy-gate', conclusion: 'action_required' }],
    });
  });

  test('a real failure next to a blocked status is failing, with only the fixable check', async () => {
    const lint = { id: 2, name: 'lint', status: 'completed', conclusion: 'failure' };
    const { ci } = ciFor(blockedRoutes([lint]));
    const state = (await ci.ciState('o/r', 7))._unsafeUnwrap();
    expect(state.kind).toBe('failing');
    expect(state.kind === 'failing' && state.checks.map((c) => c.name)).toEqual(['lint']);
  });

  test('a blocked status that is not required does not count', async () => {
    const build = { id: 1, name: 'build', status: 'completed', conclusion: 'success' };
    const { ci } = ciFor(blockedRoutes([build]));
    expect((await ci.ciState('o/r', 7, ['build']))._unsafeUnwrap()).toEqual({ kind: 'green' });
  });

  test('pending while a check runs, conflict when the PR cannot merge', async () => {
    const running = ciFor({
      'GET /repos/o/r/pulls/7': pull,
      'GET /repos/o/r/commits/abc/check-runs?per_page=100': {
        check_runs: [{ id: 1, name: 'build', status: 'in_progress', conclusion: null }],
      },
      'GET /repos/o/r/commits/abc/status': { statuses: [] },
    });
    expect((await running.ci.ciState('o/r', 7))._unsafeUnwrap()).toEqual({ kind: 'pending' });

    const dirty = ciFor({ 'GET /repos/o/r/pulls/7': { ...pull, mergeable: false } });
    expect((await dirty.ci.ciState('o/r', 7))._unsafeUnwrap()).toEqual({ kind: 'conflict' });
  });

  test('a refused token is an error naming its kind, and no GitHub call is made', async () => {
    const gh = fakeGithub({});
    const ci = createPullRequestCi(
      createRepoGithub({
        tokenFor: () => errAsync({ message: 'App not installed', kind: 'not-installed' }),
        fetch: gh.fetchImpl,
      }),
    );
    const result = await ci.ciState('o/r', 7);
    expect(result.isErr() && result.error).toMatchObject({ kind: 'not-installed' });
    expect(gh.calls).toEqual([]);
  });
});
