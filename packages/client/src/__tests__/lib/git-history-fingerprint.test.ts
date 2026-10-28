import type { GitStatusInfo } from '@funny/shared';
import { describe, expect, test } from 'vitest';

import { gitHistoryFingerprint } from '@/lib/git-history-fingerprint';

const base: GitStatusInfo = {
  threadId: 't1',
  branchKey: 'p1:main',
  state: 'dirty',
  dirtyFileCount: 2,
  unpushedCommitCount: 0,
  unpulledCommitCount: 0,
  hasRemoteBranch: true,
  isMergedIntoBase: false,
  linesAdded: 10,
  linesDeleted: 3,
};

describe('gitHistoryFingerprint', () => {
  test('is null while the status is unknown', () => {
    expect(gitHistoryFingerprint(undefined)).toBeNull();
  });

  test('ignores file edits that leave the tree dirty', () => {
    const edited = { ...base, dirtyFileCount: 5, linesAdded: 40, linesDeleted: 9 };
    expect(gitHistoryFingerprint(edited)).toBe(gitHistoryFingerprint(base));
  });

  test.each([
    ['commit', { dirtyFileCount: 0, unpushedCommitCount: 1, state: 'unpushed' as const }],
    ['amend (counts unchanged, tree cleaned)', { dirtyFileCount: 0 }],
    ['fetch with incoming commits', { unpulledCommitCount: 3 }],
    ['first push of the branch', { hasRemoteBranch: false }],
    ['merge into base', { isMergedIntoBase: true }],
  ])('changes on %s', (_label, patch) => {
    expect(gitHistoryFingerprint({ ...base, ...patch })).not.toBe(gitHistoryFingerprint(base));
  });
});
