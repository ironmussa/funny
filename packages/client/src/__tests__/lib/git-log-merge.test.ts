import { describe, expect, test } from 'vitest';

import { mergeLogEntriesByHash, uniqueLogEntriesByHash } from '@/lib/git-log-merge';

const entry = (hash: string) => ({ hash, message: `commit ${hash}` });

describe('git-log-merge', () => {
  test('keeps only the first occurrence when a fetched page contains duplicates', () => {
    expect(uniqueLogEntriesByHash([entry('a'), entry('b'), entry('a')])).toEqual([
      entry('a'),
      entry('b'),
    ]);
  });

  test('appends only unseen hashes when paginated windows overlap', () => {
    expect(
      mergeLogEntriesByHash([entry('a'), entry('b')], [entry('b'), entry('c'), entry('a')]),
    ).toEqual([entry('a'), entry('b'), entry('c')]);
  });
});
