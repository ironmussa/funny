import { describe, test, expect, vi } from 'vitest';

import {
  resolveSort,
  listParam,
  searchValue,
  mapSearchItemToPR,
  mapCommitToPRCommit,
  addLastCommitToPRs,
} from '../../routes/github/prs.js';

describe('resolveSort', () => {
  test('maps unified keys to /pulls sort + direction', () => {
    expect(resolveSort('newest', 'pulls')).toEqual({ sort: 'created', direction: 'desc' });
    expect(resolveSort('oldest', 'pulls')).toEqual({ sort: 'created', direction: 'asc' });
    expect(resolveSort('recently-updated', 'pulls')).toEqual({
      sort: 'updated',
      direction: 'desc',
    });
    expect(resolveSort('least-recently-updated', 'pulls')).toEqual({
      sort: 'updated',
      direction: 'asc',
    });
  });

  test('most-commented differs per endpoint (popularity vs comments)', () => {
    expect(resolveSort('most-commented', 'pulls')).toEqual({
      sort: 'popularity',
      direction: 'desc',
    });
    expect(resolveSort('most-commented', 'search')).toEqual({
      sort: 'comments',
      direction: 'desc',
    });
  });

  test('unknown / missing key falls back to newest', () => {
    expect(resolveSort(undefined, 'pulls')).toEqual({ sort: 'created', direction: 'desc' });
    expect(resolveSort('garbage', 'search')).toEqual({ sort: 'created', direction: 'desc' });
  });
});

describe('listParam', () => {
  test('splits, trims, drops empties, and de-dupes', () => {
    expect(listParam('a, b ,, a ,c')).toEqual(['a', 'b', 'c']);
  });
  test('empty / undefined → []', () => {
    expect(listParam(undefined)).toEqual([]);
    expect(listParam('')).toEqual([]);
    expect(listParam(' , ')).toEqual([]);
  });
});

describe('searchValue', () => {
  test('quotes values with spaces, leaves bare tokens alone', () => {
    expect(searchValue('bug')).toBe('bug');
    expect(searchValue('needs review')).toBe('"needs review"');
  });
});

describe('mapSearchItemToPR', () => {
  test('lifts merged_at out of pull_request and zeroes branch refs', () => {
    const pr = mapSearchItemToPR({
      number: 7,
      title: 'Fix thing',
      state: 'closed',
      html_url: 'https://github.com/o/r/pull/7',
      user: { login: 'alice', avatar_url: 'a.png' },
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      draft: false,
      labels: [{ name: 'bug', color: 'ff0000' }],
      assignees: [{ login: 'bob', avatar_url: 'b.png' }],
      pull_request: { merged_at: '2026-01-03T00:00:00Z' },
    });

    expect(pr.number).toBe(7);
    expect(pr.merged_at).toBe('2026-01-03T00:00:00Z');
    expect(pr.head).toEqual({ ref: '', label: '' });
    expect(pr.base).toEqual({ ref: '', label: '' });
    expect(pr.labels).toEqual([{ name: 'bug', color: 'ff0000' }]);
    expect(pr.assignees).toEqual([{ login: 'bob', avatar_url: 'b.png' }]);
    expect(pr.last_commit).toBeNull();
  });

  test('tolerates missing optional fields', () => {
    const pr = mapSearchItemToPR({ number: 1 });
    expect(pr.merged_at).toBeNull();
    expect(pr.labels).toEqual([]);
    expect(pr.assignees).toEqual([]);
    expect(pr.user).toBeNull();
  });
});

describe('mapCommitToPRCommit', () => {
  test('maps GitHub user and raw git author metadata', () => {
    expect(
      mapCommitToPRCommit({
        sha: 'abc123',
        commit: {
          message: 'fix: handle edge case',
          author: { name: 'Raw Author', date: '2026-01-02T00:00:00Z' },
          committer: { date: '2026-01-03T00:00:00Z' },
        },
        author: { login: 'alice', avatar_url: 'alice.png' },
      }),
    ).toEqual({
      sha: 'abc123',
      message: 'fix: handle edge case',
      author: { login: 'alice', avatar_url: 'alice.png' },
      author_name: 'Raw Author',
      date: '2026-01-03T00:00:00Z',
    });
  });

  test('falls back to raw author date when committer date is missing', () => {
    expect(
      mapCommitToPRCommit({
        sha: 'def456',
        commit: {
          message: 'docs: update readme',
          author: { name: 'Unlinked Author', date: '2026-01-02T00:00:00Z' },
        },
        author: null,
      }),
    ).toEqual({
      sha: 'def456',
      message: 'docs: update readme',
      author: null,
      author_name: 'Unlinked Author',
      date: '2026-01-02T00:00:00Z',
    });
  });
});

describe('addLastCommitToPRs', () => {
  test('fetches the head commit and attaches it to each PR', async () => {
    const fetchGitHubPath = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          sha: 'abc123',
          commit: {
            message: 'fix: handle edge case',
            author: { name: 'Raw Author', date: '2026-01-02T00:00:00Z' },
          },
          author: { login: 'alice', avatar_url: 'alice.png' },
        }),
      );
    });

    const [pr] = await addLastCommitToPRs(
      [
        {
          number: 7,
          title: 'Fix thing',
          state: 'open',
          html_url: 'https://github.com/o/r/pull/7',
          user: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          head: { ref: 'fix', label: 'o:fix', sha: 'abc123' },
          base: { ref: 'main', label: 'o:main' },
          commits: 4,
          draft: false,
          labels: [],
          merged_at: null,
        },
      ],
      'o',
      'r',
      fetchGitHubPath,
    );

    expect(fetchGitHubPath).toHaveBeenCalledWith('/repos/o/r/commits/abc123');
    expect(pr.commits).toBe(4);
    expect(pr.last_commit?.author?.login).toBe('alice');
    expect(pr.last_commit?.author_name).toBe('Raw Author');
  });

  test('sets last_commit to null when head sha is unavailable or fetch fails', async () => {
    const fetchGitHubPath = vi.fn(async () => new Response('', { status: 404 }));

    const prs = await addLastCommitToPRs(
      [
        {
          number: 7,
          title: 'Fix thing',
          state: 'open',
          html_url: 'https://github.com/o/r/pull/7',
          user: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          head: { ref: 'fix', label: 'o:fix' },
          base: { ref: 'main', label: 'o:main' },
          draft: false,
          labels: [],
          merged_at: null,
        },
        {
          number: 8,
          title: 'Other fix',
          state: 'open',
          html_url: 'https://github.com/o/r/pull/8',
          user: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
          head: { ref: 'other-fix', label: 'o:other-fix', sha: 'def456' },
          base: { ref: 'main', label: 'o:main' },
          draft: false,
          labels: [],
          merged_at: null,
        },
      ],
      'o',
      'r',
      fetchGitHubPath,
    );

    expect(fetchGitHubPath).toHaveBeenCalledTimes(1);
    expect(prs.map((pr) => pr.last_commit)).toEqual([null, null]);
  });
});
