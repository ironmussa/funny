/**
 * The factory's repository reads over a fake GitHub REST: a flow file is read
 * from the DEFAULT branch only (a copy on the run's or a pull request's branch
 * is never asked for), an absent file is null, and the agent's pull request is
 * found by its head branch.
 */
import { describe, expect, test } from 'bun:test';

import { createRepoGithub } from '@funny/core/github-app';
import { okAsync } from 'neverthrow';

import { createFactoryRepoReads } from '../../../services/factory/factory-repo-reads.js';
import { fakeFetch } from '../../helpers/builders-services.js';

function readsOver(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = fakeFetch(async (url) => {
    const key = url.replace('https://api.github.com', '');
    calls.push(key);
    if (!(key in routes)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  });
  const github = createRepoGithub({ tokenFor: () => okAsync('tok'), fetch: fetchImpl });
  return { reads: createFactoryRepoReads('o/r', github), calls };
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
});
