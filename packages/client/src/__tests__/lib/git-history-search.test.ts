import { describe, expect, test } from 'vitest';

import { commitMatchesQuery, type SearchableCommit } from '@/lib/git-history-search';

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
