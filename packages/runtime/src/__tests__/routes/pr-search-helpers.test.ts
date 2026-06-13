import { describe, test, expect } from 'vitest';

import { resolveSort, listParam, searchValue, mapSearchItemToPR } from '../../routes/github/prs.js';

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
  });

  test('tolerates missing optional fields', () => {
    const pr = mapSearchItemToPR({ number: 1 });
    expect(pr.merged_at).toBeNull();
    expect(pr.labels).toEqual([]);
    expect(pr.assignees).toEqual([]);
    expect(pr.user).toBeNull();
  });
});
