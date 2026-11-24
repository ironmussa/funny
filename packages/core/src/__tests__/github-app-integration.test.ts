/**
 * The GitHub side of the issue factory's merge queue (openspec
 * factory-integration 1.1, 1.2): branch rules, batch branches built with the
 * merges API, a tree-identical commit, and a merge pinned to the tested head,
 * against answers recorded from GitHub's API.
 */
import { describe, expect, test } from 'bun:test';

import { okAsync } from 'neverthrow';

import { createGithubIntegration, createRepoGithub } from '../github-app/index.js';
import { fakeFetch } from './helpers/test-helpers.js';

interface Answer {
  status: number;
  body?: unknown;
}

/** A GitHub whose answers are keyed by `METHOD path`; it records every request. */
function github(answers: Record<string, Answer | Answer[]>) {
  const requests: Array<{ key: string; body: unknown }> = [];
  const fetchImpl = fakeFetch(async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${url.replace('https://api.github.com', '')}`;
    requests.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const listed = answers[key];
    const answer = Array.isArray(listed) ? listed.shift() : listed;
    if (!answer) return new Response('{"message":"Not Found"}', { status: 404 });
    if (answer.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
  });
  const gh = createRepoGithub({ tokenFor: () => okAsync('tok'), fetch: fetchImpl });
  return { provider: createGithubIntegration(gh), requests };
}

const RULES = 'GET /repos/o/r/rules/branches/main?per_page=100';
const noQueue = { status: 200, body: { data: { repository: { mergeQueue: null } } } };

describe('branch rules', () => {
  test('a ruleset that requires checks to be up to date, with its check names', async () => {
    const { provider } = github({
      [RULES]: {
        status: 200,
        body: [
          { type: 'pull_request' },
          {
            type: 'required_status_checks',
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [{ context: 'test' }, { context: 'lint' }],
            },
          },
        ],
      },
      'POST /graphql': noQueue,
    });
    expect((await provider.branchRules('o/r', 'main'))._unsafeUnwrap()).toEqual({
      mergeQueue: false,
      requiredChecks: ['test', 'lint'],
      upToDate: true,
    });
  });

  test('a merge queue required by a ruleset, or seen through GraphQL', async () => {
    const byRuleset = github({
      [RULES]: { status: 200, body: [{ type: 'merge_queue' }] },
      'POST /graphql': noQueue,
    });
    expect((await byRuleset.provider.branchRules('o/r', 'main'))._unsafeUnwrap().mergeQueue).toBe(
      true,
    );
    const byGraphql = github({
      [RULES]: { status: 200, body: [] },
      'POST /graphql': {
        status: 200,
        body: { data: { repository: { mergeQueue: { id: 'MQ_1' } } } },
      },
    });
    expect((await byGraphql.provider.branchRules('o/r', 'main'))._unsafeUnwrap().mergeQueue).toBe(
      true,
    );
  });

  // ironmussa/test-funny (private, GitHub Free) answers 403 to the rules of any branch.
  test('a plan without rules: nothing required, and up to date is unknown', async () => {
    const { provider } = github({
      [RULES]: { status: 403, body: { message: 'Upgrade to GitHub Pro' } },
      'POST /graphql': {
        status: 200,
        body: { errors: [{ message: 'mergeQueue is not available' }] },
      },
    });
    expect((await provider.branchRules('o/r', 'main'))._unsafeUnwrap()).toEqual({
      mergeQueue: false,
      requiredChecks: [],
      upToDate: null,
    });
  });
});

describe('batch branches', () => {
  test('a merge into the staging branch writes a commit; nothing to merge; a conflict', async () => {
    const { provider, requests } = github({
      'POST /repos/o/r/merges': [
        { status: 201, body: { sha: 'm1' } },
        { status: 204 },
        { status: 409, body: { message: 'Merge conflict' } },
      ],
    });
    const merge = () =>
      provider.mergeRefInto('o/r', 'factory/staging/b1', 'abc123', 'Merge #12 [skip ci]');
    expect((await merge())._unsafeUnwrap()).toEqual({ kind: 'merged', sha: 'm1' });
    expect((await merge())._unsafeUnwrap()).toEqual({ kind: 'up-to-date' });
    expect((await merge())._unsafeUnwrap()).toEqual({ kind: 'conflict' });
    expect(requests[0]!.body).toEqual({
      base: 'factory/staging/b1',
      head: 'abc123',
      commit_message: 'Merge #12 [skip ci]',
    });
  });

  test('setting a branch creates it, or moves it when it exists', async () => {
    const { provider, requests } = github({
      'POST /repos/o/r/git/refs': {
        status: 422,
        body: { message: 'Reference already exists' },
      },
      'PATCH /repos/o/r/git/refs/heads/factory/queue/b1': { status: 200, body: {} },
    });
    expect((await provider.setBranch('o/r', 'factory/queue/b1', 'c2')).isOk()).toBe(true);
    expect(requests.map((r) => r.key)).toEqual([
      'POST /repos/o/r/git/refs',
      'PATCH /repos/o/r/git/refs/heads/factory/queue/b1',
    ]);
    expect(requests[1]!.body).toEqual({ sha: 'c2', force: true });
  });

  test('a tree-identical commit has the same tree and the tested commit as parent', async () => {
    const { provider, requests } = github({
      'GET /repos/o/r/git/commits/m3': { status: 200, body: { sha: 'm3', tree: { sha: 't9' } } },
      'POST /repos/o/r/git/commits': { status: 201, body: { sha: 'q1' } },
    });
    expect((await provider.sameTreeCommit('o/r', 'm3', 'Batch b1'))._unsafeUnwrap()).toBe('q1');
    expect(requests[1]!.body).toEqual({ message: 'Batch b1', tree: 't9', parents: ['m3'] });
  });

  test('deleting a branch already gone is not an error', async () => {
    const { provider } = github({
      'DELETE /repos/o/r/git/refs/heads/factory/staging/b1': {
        status: 422,
        body: { message: 'Reference does not exist' },
      },
    });
    expect((await provider.deleteBranch('o/r', 'factory/staging/b1')).isOk()).toBe(true);
  });

  // Found in the stacked E2E: deleting a merged blocker's branch closed the pull request stacked on it.
  const LIST_STACKED = 'GET /repos/o/r/pulls?base=factory%2Fissue-86-r&state=open&per_page=100';
  const DELETE_86 = 'DELETE /repos/o/r/git/refs/heads/factory/issue-86-r';

  test('the pull requests based on a merged branch move to its base before it is deleted', async () => {
    const { provider, requests } = github({
      [LIST_STACKED]: { status: 200, body: [{ number: 90 }] },
      'PATCH /repos/o/r/pulls/90': { status: 200, body: { number: 90 } },
      [DELETE_86]: { status: 204 },
    });
    expect((await provider.deleteBranch('o/r', 'factory/issue-86-r', 'main')).isOk()).toBe(true);
    expect(requests.map((r) => r.key)).toEqual([
      LIST_STACKED,
      'PATCH /repos/o/r/pulls/90',
      DELETE_86,
    ]);
    expect(requests[1]!.body).toEqual({ base: 'main' });
  });

  test('a branch whose dependent pull request cannot move is kept', async () => {
    const { provider, requests } = github({
      [LIST_STACKED]: { status: 200, body: [{ number: 90 }] },
      'PATCH /repos/o/r/pulls/90': { status: 422, body: { message: 'Validation Failed' } },
    });
    expect((await provider.deleteBranch('o/r', 'factory/issue-86-r', 'main')).isErr()).toBe(true);
    expect(requests.map((r) => r.key)).not.toContain(DELETE_86);
  });
});

describe('what changed on the base', () => {
  test("the paths between two commits, from GitHub's compare", async () => {
    const { provider } = github({
      'GET /repos/o/r/compare/b1...b2': {
        status: 200,
        body: { files: [{ filename: 'src/a.ts' }, { filename: 'bun.lock' }] },
      },
    });
    expect((await provider.changedPaths('o/r', 'b1', 'b2'))._unsafeUnwrap()).toEqual([
      'src/a.ts',
      'bun.lock',
    ]);
  });
});

describe('merging a pull request', () => {
  test('merged at the tested head, pinned with its sha', async () => {
    const { provider, requests } = github({
      'PUT /repos/o/r/pulls/12/merge': {
        status: 200,
        body: { merged: true, sha: 'land1', message: 'Pull Request successfully merged' },
      },
    });
    const merged = await provider.mergePullRequest('o/r', 12, { sha: 'h12', method: 'squash' });
    expect(merged._unsafeUnwrap()).toEqual({ kind: 'merged', sha: 'land1' });
    expect(requests[0]!.body).toEqual({ sha: 'h12', merge_method: 'squash' });
  });

  test('a head that moved, or a rule, refuses the merge with its reason', async () => {
    const { provider } = github({
      'PUT /repos/o/r/pulls/12/merge': [
        {
          status: 409,
          body: { message: 'Head branch was modified. Review and try the merge again.' },
        },
        { status: 405, body: { message: 'Required status check "test" is expected.' } },
      ],
    });
    const merge = () => provider.mergePullRequest('o/r', 12, { sha: 'h12', method: 'squash' });
    expect((await merge())._unsafeUnwrap()).toEqual({
      kind: 'refused',
      reason: 'Head branch was modified. Review and try the merge again.',
      status: 409,
    });
    expect((await merge())._unsafeUnwrap()).toMatchObject({ kind: 'refused', status: 405 });
  });

  test("into the host's queue: by its GraphQL id, pinned to the head", async () => {
    const { provider, requests } = github({
      'POST /graphql': [
        {
          status: 200,
          body: {
            data: {
              repository: {
                pullRequest: { id: 'PR_12', merged: false, state: 'OPEN', mergeQueueEntry: null },
              },
            },
          },
        },
        {
          status: 200,
          body: { data: { enqueuePullRequest: { mergeQueueEntry: { state: 'QUEUED' } } } },
        },
      ],
    });
    expect((await provider.enqueueInHostQueue('o/r', 12, 'h12'))._unsafeUnwrap()).toEqual({
      kind: 'queued',
    });
    expect(requests[1]!.body).toMatchObject({ variables: { id: 'PR_12', head: 'h12' } });
  });
});
