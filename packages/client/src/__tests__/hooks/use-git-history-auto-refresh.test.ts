import type { GitStatusInfo } from '@funny/shared';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { seedGitStatus } from '@/data/git-status/testing';
import { useGitHistoryAutoRefresh } from '@/hooks/use-git-history-auto-refresh';
import { HISTORY_REFRESH_DEBOUNCE_MS } from '@/machines/history-refresh-machine';

const BK = 'p1:main';
const clean: GitStatusInfo = {
  threadId: 't1',
  branchKey: BK,
  state: 'clean',
  dirtyFileCount: 0,
  unpushedCommitCount: 0,
  unpulledCommitCount: 0,
  hasRemoteBranch: true,
  isMergedIntoBase: false,
  linesAdded: 0,
  linesDeleted: 0,
};

function setStatus(status: GitStatusInfo) {
  act(() => {
    seedGitStatus({
      statusByBranch: { [BK]: status },
      threadToBranchKey: { t1: BK },
    });
  });
}

function renderAutoRefresh(visible = true) {
  const refresh = vi.fn(async () => {});
  const view = renderHook(
    ({ visible: v }: { visible: boolean }) =>
      useGitHistoryAutoRefresh({
        effectiveThreadId: 't1',
        projectModeId: null,
        contextKey: 't1::p1::true',
        visible: v,
        enabled: true,
        busy: false,
        refresh,
      }),
    { initialProps: { visible } },
  );
  return { ...view, refresh };
}

async function flushDebounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HISTORY_REFRESH_DEBOUNCE_MS);
  });
}

describe('useGitHistoryAutoRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    seedGitStatus({ statusByBranch: {}, threadToBranchKey: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('the first status for a context is a baseline, not a change', async () => {
    const { refresh } = renderAutoRefresh();
    setStatus(clean);
    await flushDebounce();
    expect(refresh).not.toHaveBeenCalled();
  });

  test('reloads after a commit lands in the git-status store', async () => {
    setStatus({ ...clean, state: 'dirty', dirtyFileCount: 2, linesAdded: 5 });
    const { refresh } = renderAutoRefresh();
    setStatus({ ...clean, state: 'unpushed', unpushedCommitCount: 1 });
    await flushDebounce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('ignores file edits that do not touch history', async () => {
    setStatus({ ...clean, state: 'dirty', dirtyFileCount: 1, linesAdded: 1 });
    const { refresh } = renderAutoRefresh();
    setStatus({ ...clean, state: 'dirty', dirtyFileCount: 4, linesAdded: 30 });
    await flushDebounce();
    expect(refresh).not.toHaveBeenCalled();
  });

  test('defers the reload of a hidden tab until it is revealed', async () => {
    setStatus(clean);
    const { refresh, rerender } = renderAutoRefresh(false);
    setStatus({ ...clean, unpulledCommitCount: 2 });
    await flushDebounce();
    expect(refresh).not.toHaveBeenCalled();

    rerender({ visible: true });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('an explicit invalidate merges with the status change into one reload', async () => {
    setStatus({ ...clean, unpushedCommitCount: 1, state: 'unpushed' });
    const { result, refresh } = renderAutoRefresh();
    // After a push: the forced status refetch lands, then the caller invalidates.
    setStatus(clean);
    act(() => result.current());
    await flushDebounce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test('invalidate alone reloads when the status does not move (non-current branch push)', async () => {
    setStatus(clean);
    const { result, refresh } = renderAutoRefresh();
    act(() => result.current());
    await flushDebounce();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
