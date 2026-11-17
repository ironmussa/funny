/**
 * An issue's blockers from GitHub's "blocked by" relation: every page, the
 * blocker's own repository, and an unknown state counted as open.
 */
import { describe, expect, test } from 'bun:test';

import { errAsync, okAsync } from 'neverthrow';

import { issueBlockers, openBlockers, type RepoGithub } from '../github-app/index.js';

function stubGithub(pages: unknown[][], calls: string[] = []): RepoGithub {
  return {
    json: <T>(_repo: string, _method: string, path: string) => {
      calls.push(path);
      const page = Number(new URL(`https://x${path}`).searchParams.get('page'));
      return okAsync((pages[page - 1] ?? []) as T);
    },
    text: () => okAsync(''),
  };
}

describe('issueBlockers', () => {
  test('reads every page and names each blocker repository', async () => {
    const first = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, state: 'closed' }));
    const calls: string[] = [];
    const github = stubGithub(
      [
        first,
        [
          { number: 101, state: 'open' },
          { number: 5, state: 'open', repository_url: 'https://api.github.com/repos/Other/Lib' },
        ],
      ],
      calls,
    );

    const blockers = (await issueBlockers(github, 'acme/app', 9))._unsafeUnwrap();

    expect(calls).toEqual([
      '/repos/acme/app/issues/9/dependencies/blocked_by?per_page=100&page=1',
      '/repos/acme/app/issues/9/dependencies/blocked_by?per_page=100&page=2',
    ]);
    expect(blockers).toHaveLength(102);
    expect(blockers.at(-2)).toEqual({ number: 101, repo: 'acme/app', open: true });
    expect(blockers.at(-1)).toEqual({ number: 5, repo: 'other/lib', open: true });
  });

  test('a blocker without a state counts as open', async () => {
    const github = stubGithub([[{ number: 3 }, { number: 4, state: 'closed' }]]);
    expect((await openBlockers(github, 'acme/app', 9))._unsafeUnwrap()).toEqual([3]);
  });

  test('a GitHub failure is an error, not an empty list', async () => {
    const github: RepoGithub = {
      json: () => errAsync({ message: 'GitHub answered 404', status: 404 }),
      text: () => okAsync(''),
    };
    expect((await issueBlockers(github, 'acme/app', 9)).isErr()).toBe(true);
  });
});
