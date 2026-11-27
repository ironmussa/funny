import { describe, expect, test } from 'bun:test';

import {
  parseListFilters,
  writeListFilters,
  type ListFilters,
} from '@/components/all-threads/list-filter-params';

const filters: ListFilters = {
  status: new Set(['running', 'failed']),
  git: new Set(['dirty']),
  mode: new Set(['worktree']),
  type: new Set(['normal']),
  origin: new Set(['factory']),
  automation: new Set(['a1', 'a2']),
  showArchived: true,
  sortField: 'created',
  sortDir: 'asc',
};

describe('list filter params', () => {
  test('every filter survives a trip through the URL', () => {
    const params = writeListFilters(new URLSearchParams(), filters);
    expect(parseListFilters(params)).toEqual(filters);
  });

  test('keeps the params that are not filters', () => {
    const current = new URLSearchParams('project=p1&search=lint&returnThread=t1');
    const params = writeListFilters(current, filters);
    expect(params.get('project')).toBe('p1');
    expect(params.get('search')).toBe('lint');
    expect(params.get('returnThread')).toBe('t1');
  });

  test('defaults write no param', () => {
    const empty = parseListFilters(new URLSearchParams());
    expect(writeListFilters(new URLSearchParams('project=p1'), empty).toString()).toBe(
      'project=p1',
    );
  });

  test('a scratch-only type keeps the short ?scratch=1 form', () => {
    const params = writeListFilters(new URLSearchParams(), {
      ...parseListFilters(new URLSearchParams()),
      type: new Set(['scratch']),
    });
    expect(params.toString()).toBe('scratch=1');
    expect(parseListFilters(params).type).toEqual(new Set(['scratch']));
  });

  test('drops unknown origins', () => {
    const parsed = parseListFilters(new URLSearchParams('origin=factory,bogus'));
    expect(parsed.origin).toEqual(new Set(['factory']));
  });

  test('keeps the automation origin the inbox links with', () => {
    const parsed = parseListFilters(new URLSearchParams('origin=automation'));
    expect(parsed.origin).toEqual(new Set(['automation']));
  });
});
