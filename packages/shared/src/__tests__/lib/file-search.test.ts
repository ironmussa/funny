import { describe, expect, test } from 'bun:test';

import { fileSearchHighlightIndices, scoreFilePath } from '../../lib/file-search';

describe('scoreFilePath', () => {
  test('prefers word starts while preserving fuzzy highlight indices', () => {
    expect(scoreFilePath('src/users/service.ts', 'ss', false)).toEqual({
      score: 70,
      indices: [0, 10],
    });
  });

  test('supports exact-case bonuses', () => {
    const insensitive = scoreFilePath('src/UserService.ts', 'US', false);
    const sensitive = scoreFilePath('src/UserService.ts', 'US', true);

    expect(sensitive?.score).toBeGreaterThan(insensitive?.score ?? 0);
    expect(sensitive?.indices).toEqual(insensitive?.indices);
  });

  test('rejects paths whose characters do not match in order', () => {
    expect(scoreFilePath('src/UserService.ts', 'xyz', false)).toBeNull();
  });

  test('prefers a contiguous filename highlight over earlier directory characters', () => {
    const path = 'packages/client/src/hooks/use-slash-skills.ts';

    expect(fileSearchHighlightIndices(path, 'slash')).toEqual([30, 31, 32, 33, 34]);
  });

  test('falls back to full-path fuzzy indices when the filename cannot satisfy the query', () => {
    const path = 'packages/runner-protocol-rust/target/debug/deps/libhashbrown.rlib';

    expect(fileSearchHighlightIndices(path, 'slash')).toEqual([7, 23, 31, 46, 51]);
  });
});
