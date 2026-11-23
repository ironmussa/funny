import { describe, expect, test } from 'bun:test';

import { okAsync } from 'neverthrow';

import { createPullRequestCi, createRepoGithub, revertPullRequest } from '../github-app/index.js';
import { fakeFetch } from './helpers/test-helpers.js';

/** A GitHub that answers each GraphQL call from `answers`, in order. */
function graphqlGithub(answers: unknown[]) {
  const queries: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetchImpl = fakeFetch(async (_url, init) => {
    queries.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(answers[queries.length - 1] ?? {}), { status: 200 });
  });
  return { gh: createRepoGithub({ tokenFor: () => okAsync('tok'), fetch: fetchImpl }), queries };
}

const found = (merged: boolean) => ({
  data: { repository: { pullRequest: { id: 'PR_1', merged } } },
});

describe('reverting a merged pull request', () => {
  test('opens the revert pull request and answers its URL', async () => {
    const { gh, queries } = graphqlGithub([
      found(true),
      {
        data: {
          revertPullRequest: {
            revertPullRequest: { url: 'https://github.com/o/r/pull/20', number: 20 },
          },
        },
      },
    ]);
    const reverted = await revertPullRequest(gh, 'o/r', 12, { title: 'Revert #12' });
    expect(reverted._unsafeUnwrap()).toEqual({ url: 'https://github.com/o/r/pull/20', number: 20 });
    expect(queries[1]?.variables).toEqual({ id: 'PR_1', title: 'Revert #12' });
  });

  test('a pull request that is not merged is not reverted', async () => {
    const { gh, queries } = graphqlGithub([found(false)]);
    expect((await revertPullRequest(gh, 'o/r', 12)).isErr()).toBe(true);
    expect(queries).toHaveLength(1);
  });

  test("GitHub's refusal is the error", async () => {
    const { gh } = graphqlGithub([
      found(true),
      { errors: [{ message: 'conflicts with later commits' }] },
    ]);
    expect((await revertPullRequest(gh, 'o/r', 12))._unsafeUnwrapErr().message).toContain(
      'conflicts with later commits',
    );
  });
});

describe('the state of a base branch', () => {
  test('reads the commit the branch is at, then its checks', async () => {
    const fetchImpl = fakeFetch(async (url) => {
      const path = url.replace('https://api.github.com', '');
      const routes: Record<string, unknown> = {
        '/repos/o/r/commits/release/1.x': { sha: 'abc' },
        '/repos/o/r/commits/abc/check-runs?per_page=100': {
          check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }],
        },
        '/repos/o/r/commits/abc/status': { statuses: [] },
      };
      return path in routes
        ? new Response(JSON.stringify(routes[path]), { status: 200 })
        : new Response('{}', { status: 404 });
    });
    const ci = createPullRequestCi(
      createRepoGithub({ tokenFor: () => okAsync('tok'), fetch: fetchImpl }),
    );
    expect((await ci.refState('o/r', 'release/1.x'))._unsafeUnwrap()).toEqual({
      sha: 'abc',
      ci: { kind: 'green' },
    });
  });
});
