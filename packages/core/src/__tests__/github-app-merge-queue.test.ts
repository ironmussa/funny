import { describe, expect, test } from 'bun:test';

import { okAsync } from 'neverthrow';

import {
  createRepoGithub,
  enqueuePullRequest,
  mergeQueueState,
  requiresMergeQueue,
} from '../github-app/index.js';
import { fakeFetch } from './helpers/test-helpers.js';

interface Refusal {
  status: number;
  body: unknown;
}
const isRefusal = (value: unknown): value is Refusal =>
  typeof value === 'object' && value !== null && 'status' in value && 'body' in value;

/** A GitHub whose REST answers come from `rest` and whose GraphQL answer is `graphql`. */
function github(rest: Record<string, unknown>, graphql: unknown = {}) {
  const queries: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetchImpl = fakeFetch(async (url, init) => {
    const path = url.replace('https://api.github.com', '');
    if (path === '/graphql') {
      queries.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(graphql), { status: 200 });
    }
    if (!(path in rest)) return new Response('{"message":"Not Found"}', { status: 404 });
    const answer = rest[path];
    // `{ status, body }` answers with that status.
    if (isRefusal(answer)) {
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    return new Response(JSON.stringify(answer), { status: 200 });
  });
  return { gh: createRepoGithub({ tokenFor: () => okAsync('tok'), fetch: fetchImpl }), queries };
}

const pullRequest = (fields: Record<string, unknown>) => ({
  data: { repository: { pullRequest: { id: 'PR_1', merged: false, state: 'OPEN', ...fields } } },
});

describe("GitHub's merge queue", () => {
  test('a branch whose rules include the merge queue requires it', async () => {
    const rules = '/repos/o/r/rules/branches/main?per_page=100';
    const required = github({ [rules]: [{ type: 'pull_request' }, { type: 'merge_queue' }] });
    expect((await requiresMergeQueue(required.gh, 'o/r', 'main'))._unsafeUnwrap()).toBe(true);
    const other = github({ [rules]: [{ type: 'pull_request' }] });
    expect((await requiresMergeQueue(other.gh, 'o/r', 'main'))._unsafeUnwrap()).toBe(false);
    // A branch without rules answers 404.
    expect((await requiresMergeQueue(github({}).gh, 'o/r', 'main'))._unsafeUnwrap()).toBe(false);
  });

  // ironmussa/test-funny (private, GitHub Free) answers this to the rules of any branch.
  test('a repository whose plan has no rules does not require the queue', async () => {
    const rules = '/repos/o/r/rules/branches/main?per_page=100';
    const free = github({
      [rules]: {
        status: 403,
        body: { message: 'Upgrade to GitHub Pro or make this repository public.' },
      },
    });
    expect((await requiresMergeQueue(free.gh, 'o/r', 'main'))._unsafeUnwrap()).toBe(false);
    // Another failure is still a failure: it is not read as "no queue".
    const down = github({ [rules]: { status: 502, body: { message: 'bad gateway' } } });
    expect((await requiresMergeQueue(down.gh, 'o/r', 'main')).isErr()).toBe(true);
  });

  test('where a pull request stands', async () => {
    const stateOf = async (fields: Record<string, unknown>) =>
      (await mergeQueueState(github({}, pullRequest(fields)).gh, 'o/r', 7))._unsafeUnwrap().kind;
    expect(await stateOf({ mergeQueueEntry: { state: 'AWAITING_CHECKS' } })).toBe('queued');
    expect(await stateOf({ merged: true, state: 'MERGED' })).toBe('merged');
    expect(await stateOf({ mergeQueueEntry: null })).toBe('not-queued');
    expect(await stateOf({ state: 'CLOSED' })).toBe('closed');
  });

  test('an answer without the pull request is an error', async () => {
    const { gh } = github({}, { data: null, errors: [{ message: 'Could not resolve' }] });
    expect((await mergeQueueState(gh, 'o/r', 7)).isErr()).toBe(true);
  });

  test('enqueue is pinned to the expected head', async () => {
    const { gh, queries } = github({}, { data: { enqueuePullRequest: {} } });
    expect((await enqueuePullRequest(gh, 'o/r', 'PR_1', 'abc'))._unsafeUnwrap()).toEqual({
      kind: 'queued',
    });
    expect(queries[0]?.variables).toEqual({ id: 'PR_1', head: 'abc' });
  });

  test("GitHub's refusals are told apart", async () => {
    const answer = async (message: string) =>
      (
        await enqueuePullRequest(github({}, { errors: [{ message }] }).gh, 'o/r', 'PR_1', 'abc')
      )._unsafeUnwrap();
    expect(await answer('Pull request is already queued to merge')).toEqual({ kind: 'queued' });
    expect(await answer('Head sha was not abc')).toEqual({ kind: 'head-moved' });
    expect(await answer('Required status check "ci" is expected')).toEqual({
      kind: 'refused',
      reason: 'Required status check "ci" is expected',
    });
  });
});
