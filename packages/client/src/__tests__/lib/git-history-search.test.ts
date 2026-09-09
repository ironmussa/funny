import { describe, expect, test } from 'vitest';

import {
  commitMatchesFilters,
  commitMatchesQuery,
  type SearchableCommit,
} from '@/lib/git-history-search';

const c = (over: Partial<SearchableCommit>): SearchableCommit => ({ message: '', ...over });

describe('commitMatchesQuery', () => {
  test('blank query matches everything (no filter)', () => {
    expect(commitMatchesQuery(c({ message: 'anything' }), '')).toBe(true);
    expect(commitMatchesQuery(c({ message: 'anything' }), '   ')).toBe(true);
  });

  test('matches on the commit subject / title', () => {
    expect(commitMatchesQuery(c({ message: 'fix login redirect' }), 'login')).toBe(true);
    expect(commitMatchesQuery(c({ message: 'fix login redirect' }), 'logout')).toBe(false);
  });

  test('matches on the full or short commit SHA', () => {
    const commit = c({
      hash: '8a7c42d9fb3b544d6ddac03bbdd9a65536f6c05a',
      shortHash: '8a7c42d',
      message: 'fix history filter',
    });
    expect(commitMatchesQuery(commit, '8a7c42d')).toBe(true);
    expect(commitMatchesQuery(commit, '03bbdd9')).toBe(true);
  });

  test('matches on the commit body / description', () => {
    const commit = c({ message: 'chore', body: 'bumps undici to 8.3.0' });
    expect(commitMatchesQuery(commit, 'undici')).toBe(true);
  });

  test('matches on a branch / tag ref name the commit carries', () => {
    const commit = c({ message: 'tip', refs: [{ name: 'origin/dependabot/bun/i18next' }] });
    expect(commitMatchesQuery(commit, 'dependabot')).toBe(true);
    expect(commitMatchesQuery(commit, 'i18next')).toBe(true);
  });

  test('is case-insensitive across all fields', () => {
    expect(commitMatchesQuery(c({ message: 'Fix LOGIN' }), 'login')).toBe(true);
    expect(commitMatchesQuery(c({ message: 'x', hash: 'ABCDEF1234' }), 'abcdef')).toBe(true);
    expect(commitMatchesQuery(c({ message: 'x', body: 'Undici' }), 'undici')).toBe(true);
    expect(commitMatchesQuery(c({ message: 'x', refs: [{ name: 'Feat/X' }] }), 'feat/x')).toBe(
      true,
    );
  });

  test('returns false when nothing matches', () => {
    const commit = c({ message: 'add tests', body: 'unit only', refs: [{ name: 'main' }] });
    expect(commitMatchesQuery(commit, 'zzz')).toBe(false);
  });
});

describe('commitMatchesFilters', () => {
  const unpushed = new Set(['local']);
  const unpulled = new Set(['remote']);
  const inferred = new Set(['inferred']);
  const commits = ['local', 'remote', 'inferred', 'synced'].map((hash) => ({
    hash,
    message: hash === 'local' ? 'fix login' : 'update docs',
  }));

  test.each([
    ['all', ['local', 'remote', 'inferred', 'synced']],
    ['pull', ['remote', 'inferred']],
    ['push', ['local']],
  ] as const)('filters %s using the graph sync markers', (filter, expected) => {
    expect(
      commits
        .filter((commit) => commitMatchesFilters(commit, '', filter, unpushed, unpulled, inferred))
        .map((commit) => commit.hash),
    ).toEqual(expected);
  });

  test('combines status with text search and handles no matches', () => {
    expect(commitMatchesFilters(commits[0], 'login', 'push', unpushed, unpulled, inferred)).toBe(
      true,
    );
    expect(commitMatchesFilters(commits[0], 'docs', 'push', unpushed, unpulled, inferred)).toBe(
      false,
    );
    expect(commitMatchesFilters(commits[3], '', 'pull', unpushed, unpulled, inferred)).toBe(false);
  });

  test('recognizes pending commits appended by pagination', () => {
    const later = { hash: 'later', message: 'older local commit' };
    expect(
      commitMatchesFilters(later, '', 'push', new Set([...unpushed, 'later']), unpulled, inferred),
    ).toBe(true);
  });
});
