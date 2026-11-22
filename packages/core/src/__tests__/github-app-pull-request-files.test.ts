import { describe, expect, test } from 'bun:test';

import { okAsync } from 'neverthrow';

import {
  createRepoGithub,
  listPullRequestFiles,
  MAX_PULL_REQUEST_FILES,
} from '../github-app/index.js';
import { fakeFetch } from './helpers/test-helpers.js';

const file = (index: number) => ({
  filename: `src/f${index}.ts`,
  status: 'modified',
  additions: 1,
  deletions: 0,
  patch: '@@ -1 +1 @@\n+x',
});

/** A GitHub whose pull request 7 has `total` files, served 100 per page. */
function githubWith(total: number) {
  const pages: number[] = [];
  const fetchImpl = fakeFetch(async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    const start = (page - 1) * 100;
    const count = Math.max(0, Math.min(100, total - start));
    const body = Array.from({ length: count }, (_, i) => file(start + i));
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { github: createRepoGithub({ tokenFor: () => okAsync('tok'), fetch: fetchImpl }), pages };
}

describe('listPullRequestFiles', () => {
  test('maps a file, with its previous path when renamed and no patch when GitHub gives none', async () => {
    const fetchImpl = fakeFetch(
      async () =>
        new Response(
          JSON.stringify([
            {
              filename: 'b.png',
              previous_filename: 'a.png',
              status: 'renamed',
              additions: 0,
              deletions: 0,
            },
            file(1),
          ]),
          { status: 200 },
        ),
    );
    const github = createRepoGithub({ tokenFor: () => okAsync('tok'), fetch: fetchImpl });
    expect((await listPullRequestFiles(github, 'o/r', 7))._unsafeUnwrap()).toEqual({
      files: [
        { path: 'b.png', previousPath: 'a.png', status: 'renamed', additions: 0, deletions: 0 },
        {
          path: 'src/f1.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          patch: '@@ -1 +1 @@\n+x',
        },
      ],
      truncated: false,
    });
  });

  test('reads every page of a change', async () => {
    const { github, pages } = githubWith(250);
    const read = (await listPullRequestFiles(github, 'o/r', 7))._unsafeUnwrap();
    expect(read.files).toHaveLength(250);
    expect(read.truncated).toBe(false);
    expect(pages).toEqual([1, 2, 3]);
  });

  test('stops at the cap and says the list is not whole', async () => {
    const { github, pages } = githubWith(MAX_PULL_REQUEST_FILES + 500);
    const read = (await listPullRequestFiles(github, 'o/r', 7))._unsafeUnwrap();
    expect(read.files).toHaveLength(MAX_PULL_REQUEST_FILES);
    expect(read.truncated).toBe(true);
    expect(pages).toHaveLength(MAX_PULL_REQUEST_FILES / 100);
  });

  test('a GitHub error is the error of the read', async () => {
    const fetchImpl = fakeFetch(async () => new Response('no', { status: 403 }));
    const github = createRepoGithub({ tokenFor: () => okAsync('tok'), fetch: fetchImpl });
    expect((await listPullRequestFiles(github, 'o/r', 7))._unsafeUnwrapErr().status).toBe(403);
  });
});
