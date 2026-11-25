/**
 * The writes of the factory's `merge` step when GitHub itself fails (runs
 * #457 and #481: a 500 to update-branch and a 502 to the merge left both
 * waiting for a person): tried again after a wait, never after a refusal, and
 * a merge only after reading whether the failed attempt merged.
 */
import { describe, expect, test } from 'bun:test';

import { okAsync } from 'neverthrow';

import { createFactoryPullRequests } from '../../../services/factory/factory-pull-requests.js';
import { fakeFetch } from '../../helpers/builders-services.js';

const pr = { repo: 'o/r', number: 7, branch: 'factory/7', userId: 'alice', projectId: 'p1' };
const openPull = {
  node_id: 'PR_1',
  mergeable: true,
  mergeable_state: 'clean',
  state: 'open',
  merged: false,
  head: { sha: 'abc' },
  base: { ref: 'main' },
  auto_merge: null,
};
const green = {
  'GET /repos/o/r/pulls/7': openPull,
  'GET /repos/o/r/commits/abc/check-runs?per_page=100': {
    check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }],
  },
  'GET /repos/o/r/commits/abc/status': { statuses: [] },
};
const UPDATE = 'PUT /repos/o/r/pulls/7/update-branch';
const MERGE = 'PUT /repos/o/r/pulls/7/merge';

/** A status GitHub answers with, a request that got no answer, or a 200 body. */
type Answer = { status: number; body?: unknown } | 'network' | { [field: string]: unknown };
/** A route's answers in order (the last one repeats), or one fixed answer. */
type Route = Answer | Answer[];

const isStatus = (answer: Answer): answer is { status: number; body?: unknown } =>
  typeof answer === 'object' && typeof answer.status === 'number';

function github(routes: Record<string, Route>, delaysMs: readonly number[] = [10, 20, 30]) {
  const calls: string[] = [];
  const waits: number[] = [];
  const fetchImpl = fakeFetch(async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${url.replace('https://api.github.com', '')}`;
    calls.push(key);
    if (!(key in routes)) return new Response('not found', { status: 404 });
    const route = routes[key];
    const nth = calls.filter((call) => call === key).length;
    const answer = Array.isArray(route) ? route[Math.min(nth, route.length) - 1] : route;
    if (answer === 'network') throw new Error('socket hang up');
    if (isStatus(answer)) {
      return new Response(JSON.stringify(answer.body ?? { message: 'Server Error' }), {
        status: answer.status,
      });
    }
    return new Response(JSON.stringify(answer), { status: 200 });
  });
  const prs = createFactoryPullRequests({
    issue: () => okAsync({ token: 'tok', expiresAt: '', repo: 'o/r', level: 'write' }),
    ownerToken: async () => 'pat_alice',
    fetch: fetchImpl,
    activities: { recordServerActivity: async () => {} },
    transientRetryDelaysMs: delaysMs,
    retrySleep: async (ms) => {
      waits.push(ms);
    },
  });
  const count = (key: string) => calls.filter((call) => call === key).length;
  return { prs, calls, waits, count };
}

describe('factory merge writes when GitHub fails', () => {
  test('update-branch answered 500 is tried again after a wait, and goes through', async () => {
    const gh = github({ [UPDATE]: [{ status: 500 }, { status: 202, body: {} }] });
    const result = (await gh.prs.updateBranch(pr, 'abc'))._unsafeUnwrap();
    expect(result).toEqual({ kind: 'updating' });
    expect(gh.count(UPDATE)).toBe(2);
    expect(gh.waits).toEqual([10]);
  });

  test('a request that got no answer is tried again too', async () => {
    const gh = github({ [UPDATE]: ['network', { status: 202, body: {} }] });
    expect((await gh.prs.updateBranch(pr, 'abc')).isOk()).toBe(true);
    expect(gh.count(UPDATE)).toBe(2);
  });

  test('update-branch that took effect behind the error ends as a moved head, not a failure', async () => {
    const gh = github({
      [UPDATE]: [
        { status: 500 },
        { status: 422, body: { message: 'expected head sha didn’t match current head ref.' } },
      ],
    });
    expect((await gh.prs.updateBranch(pr, 'abc'))._unsafeUnwrap()).toEqual({ kind: 'head-moved' });
  });

  test('GitHub that keeps failing ends with its error after the last wait', async () => {
    const gh = github({ [UPDATE]: { status: 500 } });
    const result = await gh.prs.updateBranch(pr, 'abc');
    expect(result._unsafeUnwrapErr()).toEqual({
      kind: 'github-error',
      message: `GitHub answered 500 to ${UPDATE}`,
    });
    expect(gh.count(UPDATE)).toBe(4);
    expect(gh.waits).toEqual([10, 20, 30]);
  });

  test('a refusal is never tried again', async () => {
    const gh = github({ [UPDATE]: { status: 403, body: { message: 'Resource not accessible' } } });
    expect((await gh.prs.updateBranch(pr, 'abc')).isErr()).toBe(true);
    expect(gh.count(UPDATE)).toBe(1);
    expect(gh.waits).toEqual([]);
  });

  test('a stopped run does not try again', async () => {
    const stop = new AbortController();
    stop.abort();
    const gh = github({ [UPDATE]: { status: 500 } });
    const result = await gh.prs.updateBranch(pr, 'abc', stop.signal);
    expect(result._unsafeUnwrapErr().message).toBe('The run was stopped.');
    expect(gh.count(UPDATE)).toBe(0);
  });

  test('a merge answered 502 is tried again when the pull request is still open', async () => {
    const gh = github({ ...green, [MERGE]: [{ status: 502 }, { merged: true }] });
    const merged = (await gh.prs.merge(pr, { sha: 'abc', method: 'squash' }))._unsafeUnwrap();
    expect(merged.kind).toBe('merged');
    expect(gh.count(MERGE)).toBe(2);
    expect(gh.waits).toEqual([10]);
  });

  test('a merge that went through behind the 502 is not sent a second time', async () => {
    const gh = github({
      ...green,
      // Open while the checks are read, merged when it is read again after the 502.
      'GET /repos/o/r/pulls/7': [openPull, { ...openPull, state: 'closed', merged: true }],
      [MERGE]: { status: 502 },
    });
    const merged = (await gh.prs.merge(pr, { sha: 'abc', method: 'squash' }))._unsafeUnwrap();
    expect(merged).toMatchObject({ kind: 'merged', method: 'squash' });
    expect(gh.count(MERGE)).toBe(1);
  });

  test('a merge GitHub refuses (405) is not tried again', async () => {
    const gh = github({
      ...green,
      [MERGE]: { status: 405, body: { message: 'Required status check is expected' } },
    });
    const outcome = (await gh.prs.merge(pr, { sha: 'abc', method: 'squash' }))._unsafeUnwrap();
    expect(outcome.kind).toBe('not-mergeable');
    expect(gh.count(MERGE)).toBe(1);
  });
});
