/**
 * The factory's repository reads over a fake GitHub REST: a flow file is read
 * from the DEFAULT branch only (a copy on the run's or a pull request's branch
 * is never asked for), an absent file is null, and the agent's pull request is
 * found by its head branch.
 */
import { describe, expect, test } from 'bun:test';

import { createRepoGithub } from '@funny/core/github-app';
import { okAsync } from 'neverthrow';

import { readerBaseBranch } from '../../../services/factory/factory-github.js';
import { createFactoryRepoReads } from '../../../services/factory/factory-repo-reads.js';
import { fakeFetch } from '../../helpers/builders-services.js';

function readsOver(routes: Record<string, unknown>, targetBranch: string | null = null) {
  const calls: string[] = [];
  const fetchImpl = fakeFetch(async (url) => {
    const key = url.replace('https://api.github.com', '');
    calls.push(key);
    if (!(key in routes)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  });
  const github = createRepoGithub({ tokenFor: () => okAsync('tok'), fetch: fetchImpl });
  return {
    reads: createFactoryRepoReads('o/r', github, async () => targetBranch),
    calls,
  };
}

const base64 = (text: string) => Buffer.from(text).toString('base64');
const flowPath = '.funny/workflows/issue-to-merge.yaml';

describe('factory repo reads', () => {
  test("a flow file is read at the default branch, never at a pull request's branch", async () => {
    const { reads, calls } = readsOver({
      '/repos/o/r': { default_branch: 'main' },
      [`/repos/o/r/contents/${flowPath}?ref=main`]: {
        encoding: 'base64',
        content: base64('name: from-main'),
      },
      // An edited copy on the PR branch exists, but nothing should ask for it.
      [`/repos/o/r/contents/${flowPath}?ref=factory%2Fissue-7`]: {
        encoding: 'base64',
        content: base64('name: from-pr'),
      },
    });

    expect((await reads.readDefaultBranchFile(flowPath))._unsafeUnwrap()).toBe('name: from-main');
    expect(calls).toEqual(['/repos/o/r', `/repos/o/r/contents/${flowPath}?ref=main`]);
  });

  test('a file absent on the default branch is null, not an error', async () => {
    const { reads } = readsOver({ '/repos/o/r': { default_branch: 'main' } });
    expect((await reads.readDefaultBranchFile(flowPath))._unsafeUnwrap()).toBeNull();
  });

  test("the agent's pull request is found by its head branch in the repository", async () => {
    const { reads, calls } = readsOver({
      '/repos/o/r/pulls?head=o%3Afactory%2Fissue-7&state=open': [
        { number: 9, html_url: 'https://github.com/o/r/pull/9' },
      ],
    });
    expect((await reads.findPullRequest('factory/issue-7'))._unsafeUnwrap()).toEqual({
      number: 9,
      url: 'https://github.com/o/r/pull/9',
    });
    expect(calls).toHaveLength(1);
  });

  test("a branch's pull request in any state is found newest first, merged or closed too", async () => {
    const { reads } = readsOver({
      '/repos/o/r/pulls?head=o%3Afactory%2Fissue-7&state=all': [
        { number: 12, html_url: 'https://github.com/o/r/pull/12' },
      ],
    });
    expect((await reads.findPullRequest('factory/issue-7', 'all'))._unsafeUnwrap()).toEqual({
      number: 12,
      url: 'https://github.com/o/r/pull/12',
    });
  });

  test("the base is the repository's default branch when the factory names none", async () => {
    const { reads } = readsOver({ '/repos/o/r': { default_branch: 'main' } });
    expect((await reads.defaultBranch())._unsafeUnwrap()).toBe('main');
  });

  test('a configured base branch is where runs start, what ahead means, and still not where flows come from', async () => {
    const { reads, calls } = readsOver(
      {
        '/repos/o/r': { default_branch: 'main' },
        '/repos/o/r/compare/develop...factory/issue-7': { ahead_by: 2 },
        [`/repos/o/r/contents/${flowPath}?ref=main`]: {
          encoding: 'base64',
          content: base64('name: from-main'),
        },
      },
      'develop',
    );
    expect((await reads.defaultBranch())._unsafeUnwrap()).toBe('develop');
    expect((await reads.branchAhead('factory/issue-7'))._unsafeUnwrap()).toBe(true);
    expect(calls).not.toContain('/repos/o/r/compare/main...factory/issue-7');
    // Flows stay on the default branch: a feature branch cannot change what a run executes.
    expect((await reads.readDefaultBranchFile(flowPath))._unsafeUnwrap()).toBe('name: from-main');
  });

  test('a pull request found by its branch says which branch it merges into', async () => {
    const { reads } = readsOver({
      '/repos/o/r/pulls?head=o%3Afactory%2Fissue-7&state=open': [
        { number: 9, html_url: 'https://github.com/o/r/pull/9', base: { ref: 'main' } },
      ],
    });
    expect((await reads.findPullRequest('factory/issue-7'))._unsafeUnwrap()).toEqual({
      number: 9,
      url: 'https://github.com/o/r/pull/9',
      baseRef: 'main',
    });
  });

  // openspec factory-lanes, D3: the run's recorded base is what every read of "the base" answers.
  test("a reader for a run answers the run's base branch, not the factory's setting", async () => {
    const reader = { repo: 'o/r', ownerId: 'alice', projectId: 'p1' };
    let settingReads = 0;
    const setting = async () => {
      settingReads += 1;
      return 'develop';
    };
    const github = createRepoGithub({
      tokenFor: () => okAsync('tok'),
      fetch: fakeFetch(async () => new Response('{}')),
    });
    const runReads = createFactoryRepoReads('o/r', github, () =>
      readerBaseBranch({ ...reader, baseBranch: 'feature/a' }, setting),
    );

    // Answered without asking GitHub for the default branch, or the setting.
    expect((await runReads.defaultBranch())._unsafeUnwrap()).toBe('feature/a');
    expect(settingReads).toBe(0);

    // No run (the queue's checks, the sentinel): the factory's setting.
    expect(await readerBaseBranch(reader, setting)).toBe('develop');
    expect(await readerBaseBranch({ ...reader, baseBranch: null }, setting)).toBe('develop');
  });

  // openspec factory-lanes, D1: a lane's branch is cut from the branch the factory merges into.
  describe('ensureBranch', () => {
    function github(routes: Record<string, { status: number; body?: unknown }>) {
      const calls: Array<{ method: string; path: string; body?: unknown }> = [];
      const fetchImpl = fakeFetch(async (url, init) => {
        const path = url.replace('https://api.github.com', '');
        const method = init?.method ?? 'GET';
        calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const answer = routes[`${method} ${path}`] ?? { status: 404 };
        return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
      });
      const reads = createFactoryRepoReads(
        'o/r',
        createRepoGithub({ tokenFor: () => okAsync('tok'), fetch: fetchImpl }),
        async () => 'dev',
      );
      return { reads, calls };
    }

    test('a branch that exists is left alone', async () => {
      const { reads, calls } = github({
        'GET /repos/o/r/git/ref/heads/feature/a': { status: 200, body: { object: { sha: 'x' } } },
      });
      expect((await reads.ensureBranch('feature/a'))._unsafeUnwrap()).toBe('exists');
      expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
    });

    test('a missing branch is made from the head of the branch the factory merges into', async () => {
      const { reads, calls } = github({
        'GET /repos/o/r/git/ref/heads/dev': { status: 200, body: { object: { sha: 'dev-head' } } },
        'POST /repos/o/r/git/refs': { status: 201 },
      });
      expect((await reads.ensureBranch('feature/a'))._unsafeUnwrap()).toBe('created');
      expect(calls.at(-1)).toEqual({
        method: 'POST',
        path: '/repos/o/r/git/refs',
        body: { ref: 'refs/heads/feature/a', sha: 'dev-head' },
      });
    });

    test('a branch made by someone else meanwhile counts as existing', async () => {
      const { reads } = github({
        'GET /repos/o/r/git/ref/heads/dev': { status: 200, body: { object: { sha: 'dev-head' } } },
        'POST /repos/o/r/git/refs': { status: 422 },
      });
      expect((await reads.ensureBranch('feature/a'))._unsafeUnwrap()).toBe('exists');
    });

    test('a refusal is an error, not a branch', async () => {
      const { reads } = github({
        'GET /repos/o/r/git/ref/heads/dev': { status: 200, body: { object: { sha: 'dev-head' } } },
        'POST /repos/o/r/git/refs': { status: 403 },
      });
      expect((await reads.ensureBranch('feature/a')).isErr()).toBe(true);
    });
  });
});
