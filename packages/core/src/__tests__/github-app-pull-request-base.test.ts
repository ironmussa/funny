import { describe, expect, test } from 'bun:test';

import { okAsync } from 'neverthrow';

import {
  baseChangesSince,
  baseDistance,
  commitParents,
  createRepoGithub,
  updateBranch,
} from '../github-app/index.js';
import { fakeFetch } from './helpers/test-helpers.js';

/** A GitHub answering each `METHOD path` from `routes` (a body, or `[status, body]`). */
function github(routes: Record<string, unknown>) {
  const calls: Array<{ key: string; body: unknown }> = [];
  const fetchImpl = fakeFetch(async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${url.replace('https://api.github.com', '')}`;
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (!(key in routes)) return new Response('not found', { status: 404 });
    const route = routes[key];
    if (Array.isArray(route)) {
      return new Response(JSON.stringify(route[1]), { status: Number(route[0]) });
    }
    return new Response(JSON.stringify(route), { status: 200 });
  });
  return { gh: createRepoGithub({ tokenFor: () => okAsync('tok'), fetch: fetchImpl }), calls };
}

const UPDATE = 'PUT /repos/o/r/pulls/7/update-branch';

describe('a pull request and its base branch', () => {
  test('how far behind and ahead the head is', async () => {
    const { gh } = github({
      'GET /repos/o/r/compare/release/1.x...abc': { ahead_by: 3, behind_by: 2 },
    });
    expect((await baseDistance(gh, 'o/r', 'release/1.x', 'abc'))._unsafeUnwrap()).toEqual({
      behindBy: 2,
      aheadBy: 3,
    });
  });

  test('update-branch is asked only for the expected head', async () => {
    const { gh, calls } = github({ [UPDATE]: [202, { message: 'Updating pull request branch.' }] });
    expect((await updateBranch(gh, 'o/r', 7, 'abc'))._unsafeUnwrap()).toEqual({ kind: 'updating' });
    expect(calls[0]).toEqual({ key: UPDATE, body: { expected_head_sha: 'abc' } });
  });

  test('a conflict, a moved head and another refusal are told apart', async () => {
    const answer = async (message: string) =>
      (
        await updateBranch(github({ [UPDATE]: [422, { message }] }).gh, 'o/r', 7, 'abc')
      )._unsafeUnwrap();
    expect(await answer('merge conflict between base and head')).toEqual({
      kind: 'conflict',
      reason: 'merge conflict between base and head',
    });
    expect(await answer('expected head sha didn’t match current head ref.')).toEqual({
      kind: 'head-moved',
    });
    expect(await answer('Protected branch update failed')).toEqual({
      kind: 'refused',
      reason: 'Protected branch update failed',
    });
  });

  test('a server error is an error, not a refusal', async () => {
    const { gh } = github({ [UPDATE]: [502, { message: 'bad gateway' }] });
    expect((await updateBranch(gh, 'o/r', 7, 'abc'))._unsafeUnwrapErr().status).toBe(502);
  });

  test("a merge commit's parents, first parent first", async () => {
    const { gh } = github({
      'GET /repos/o/r/commits/m1': { parents: [{ sha: 'abc' }, { sha: 'base1' }] },
    });
    expect((await commitParents(gh, 'o/r', 'm1'))._unsafeUnwrap()).toEqual(['abc', 'base1']);
  });

  test('what the base gained: commit titles and files', async () => {
    const { gh } = github({
      'GET /repos/o/r/compare/abc...main': {
        ahead_by: 1,
        behind_by: 0,
        commits: [{ sha: 'c1', commit: { message: 'fix: rounding (#12)\n\nlong body' } }],
        files: [{ filename: 'src/sum.ts' }, { filename: 'bun.lock' }],
      },
    });
    expect((await baseChangesSince(gh, 'o/r', 'abc', 'main'))._unsafeUnwrap()).toEqual({
      commits: [{ sha: 'c1', title: 'fix: rounding (#12)' }],
      files: ['src/sum.ts', 'bun.lock'],
    });
  });
});
