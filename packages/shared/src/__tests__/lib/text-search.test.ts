import { describe, expect, test } from 'bun:test';

import {
  findTextSearchMatches,
  includesSearchText,
  normalizeSearchText,
} from '../../lib/text-search.js';

describe('text search', () => {
  test('matches accents and ñ without requiring them in the query', () => {
    expect(normalizeSearchText('Niña tomó café')).toBe('nina tomo cafe');
    expect(includesSearchText('Niña tomó café', 'nina tomo cafe')).toBeTrue();
  });

  test('returns original-text ranges for accented matches', () => {
    expect(findTextSearchMatches('La niña tomó café', 'nina')).toEqual([{ start: 3, end: 7 }]);
    expect(findTextSearchMatches('cafe\u0301', 'cafe')).toEqual([{ start: 0, end: 5 }]);
  });

  test('keeps case-sensitive searches literal', () => {
    expect(includesSearchText('Niña', 'nina', true)).toBeFalse();
    expect(findTextSearchMatches('Niña niña', 'niña', true)).toEqual([{ start: 5, end: 9 }]);
  });
});
