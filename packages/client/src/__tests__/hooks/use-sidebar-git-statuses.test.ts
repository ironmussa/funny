import type { GitStatusInfo } from '@funny/shared';
import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';

import { seedGitStatus } from '@/data/git-status/testing';
import { buildThread } from '@/data/threads/testing';
import { useSidebarGitStatuses } from '@/hooks/use-sidebar-git-statuses';

function status(branchKey: string, dirtyFileCount: number): GitStatusInfo {
  return {
    threadId: 't1',
    branchKey,
    state: 'dirty',
    dirtyFileCount,
    unpushedCommitCount: 0,
    unpulledCommitCount: 0,
    hasRemoteBranch: true,
    isMergedIntoBase: false,
    linesAdded: 0,
    linesDeleted: 0,
  };
}

test('keeps the same object until a listed thread status changes', () => {
  const threads = [buildThread({ id: 't1' })];
  const keys = { t1: 'p1:mine', other: 'p1:other' };
  seedGitStatus({
    statusByBranch: { 'p1:mine': status('p1:mine', 1), 'p1:other': status('p1:other', 1) },
    threadToBranchKey: keys,
  });
  const { result } = renderHook(() => useSidebarGitStatuses(threads));
  const first = result.current;
  expect(first.t1?.dirtyFileCount).toBe(1);

  // A thread outside this list changes: the caller keeps its object.
  act(() => {
    seedGitStatus({
      statusByBranch: { 'p1:mine': status('p1:mine', 1), 'p1:other': status('p1:other', 9) },
      threadToBranchKey: keys,
    });
  });
  expect(result.current).toBe(first);

  // The listed thread changes: a new object with the new status.
  act(() => {
    seedGitStatus({
      statusByBranch: { 'p1:mine': status('p1:mine', 4), 'p1:other': status('p1:other', 9) },
      threadToBranchKey: keys,
    });
  });
  expect(result.current).not.toBe(first);
  expect(result.current.t1?.dirtyFileCount).toBe(4);
});
