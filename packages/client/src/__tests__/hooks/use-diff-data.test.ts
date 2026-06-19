import type { FileDiffSummary } from '@funny/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { errAsync, ok, okAsync } from 'neverthrow';
import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { useDiffData } from '@/hooks/use-diff-data';

const { gitApiMock, fetchForThread } = vi.hoisted(() => ({
  gitApiMock: {
    getDiffSummary: vi.fn(),
    getFileDiff: vi.fn(),
    projectDiffSummary: vi.fn(),
    projectFileDiff: vi.fn(),
  },
  fetchForThread: vi.fn(),
}));

vi.mock('@/lib/api/git', () => ({
  gitApi: gitApiMock,
}));

vi.mock('@/stores/git-status-store', () => ({
  useGitStatusStore: {
    getState: () => ({
      fetchForThread,
      fetchProjectStatus: vi.fn(),
    }),
  },
}));

vi.mock('@/hooks/use-auto-refresh-diff', () => ({
  useAutoRefreshDiff: vi.fn(),
}));

function useDiffHarness({
  initialSummaries = [{ path: 'Dockerfile.dev', status: 'modified', staged: false }],
  initialSelectedFile = 'Dockerfile.dev',
  dirtyFileCount,
  linesAdded,
  linesDeleted,
}: {
  initialSummaries?: FileDiffSummary[];
  initialSelectedFile?: string | null;
  dirtyFileCount?: number;
  linesAdded?: number;
  linesDeleted?: number;
} = {}) {
  const [summaries, setSummaries] = useState<FileDiffSummary[]>(initialSummaries);
  const [selectedFile, setSelectedFile] = useState<string | null>(initialSelectedFile);
  const [, setCheckedFiles] = useState<Set<string>>(new Set());

  const diffData = useDiffData({
    hasGitContext: true,
    effectiveThreadId: 't1',
    projectModeId: null,
    selectedFile,
    expandedFile: null,
    reviewPaneOpen: true,
    summaries,
    setSummaries,
    submoduleExpansions: new Map(),
    setSelectedFile,
    setCheckedFiles,
    dirtyFileCount,
    linesAdded,
    linesDeleted,
  });

  return { ...diffData, selectedFile, summaries };
}

beforeEach(() => {
  vi.clearAllMocks();
  gitApiMock.getDiffSummary.mockReturnValue(
    okAsync({
      files: [{ path: 'Dockerfile.dev', status: 'modified', staged: false }],
      total: 1,
      truncated: false,
    }),
  );
  gitApiMock.getFileDiff.mockReturnValue(okAsync({ diff: 'fresh diff' }));
});

describe('useDiffData', () => {
  test('reloads the selected file diff on refresh even when the path is already cached', async () => {
    const { result } = renderHook(() => useDiffHarness());

    act(() => {
      result.current.setDiffCache(new Map([['Dockerfile.dev', 'stale diff']]));
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(gitApiMock.getFileDiff).toHaveBeenCalledWith(
      't1',
      'Dockerfile.dev',
      false,
      expect.any(AbortSignal),
    );
    await waitFor(() => {
      expect(result.current.diffCache.get('Dockerfile.dev')).toBe('fresh diff');
    });
  });

  test('publishes refreshed file summaries while the visible file diff is still loading', async () => {
    let resolveDiff!: () => void;
    gitApiMock.getFileDiff.mockReturnValue(
      new Promise((resolve) => {
        resolveDiff = () => resolve(ok({ diff: 'fresh diff' }));
      }) as never,
    );

    const { result } = renderHook(() =>
      useDiffHarness({ initialSummaries: [], initialSelectedFile: null }),
    );

    act(() => {
      void result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.summaries).toEqual([
        { path: 'Dockerfile.dev', status: 'modified', staged: false },
      ]);
    });
    expect(result.current.selectedFile).toBe('Dockerfile.dev');

    await act(async () => {
      resolveDiff();
    });

    await waitFor(() => {
      expect(result.current.diffCache.get('Dockerfile.dev')).toBe('fresh diff');
    });
  });

  test('recovers when git status is dirty but the diff summary state is empty', async () => {
    const { result } = renderHook(() =>
      useDiffHarness({
        initialSummaries: [],
        initialSelectedFile: null,
        dirtyFileCount: 41,
        linesAdded: 1551,
        linesDeleted: 158,
      }),
    );

    await waitFor(() => {
      expect(gitApiMock.getDiffSummary).toHaveBeenCalledWith(
        't1',
        undefined,
        undefined,
        expect.any(AbortSignal),
      );
    });
    await waitFor(() => {
      expect(result.current.summaries).toEqual([
        { path: 'Dockerfile.dev', status: 'modified', staged: false },
      ]);
    });
  });

  test('retries recovery after a failed initial refresh once fresh git status arrives', async () => {
    // The first refresh fails — e.g. the runner was still reconnecting on app
    // entry — so the panel lands in loadError with an empty summary.
    gitApiMock.getDiffSummary.mockReturnValueOnce(errAsync('runner offline'));

    const { result, rerender } = renderHook(
      (props: { dirtyFileCount: number }) =>
        useDiffHarness({
          initialSummaries: [],
          initialSelectedFile: null,
          dirtyFileCount: props.dirtyFileCount,
        }),
      { initialProps: { dirtyFileCount: 0 } },
    );

    await waitFor(() => {
      expect(result.current.loadError).toBe(true);
    });
    expect(result.current.summaries).toEqual([]);

    // Fresh git status reports a dirty worktree. Recovery must retry even though
    // the previous attempt errored (regression: loadError used to bail forever).
    rerender({ dirtyFileCount: 5 });

    await waitFor(() => {
      expect(result.current.summaries).toEqual([
        { path: 'Dockerfile.dev', status: 'modified', staged: false },
      ]);
    });
  });

  test('loads the initial summary when the review pane mounts open with empty state', async () => {
    const { result } = renderHook(() =>
      useDiffHarness({
        initialSummaries: [],
        initialSelectedFile: null,
      }),
    );

    await waitFor(() => {
      expect(gitApiMock.getDiffSummary).toHaveBeenCalledWith(
        't1',
        undefined,
        undefined,
        expect.any(AbortSignal),
      );
    });
    await waitFor(() => {
      expect(result.current.summaries).toEqual([
        { path: 'Dockerfile.dev', status: 'modified', staged: false },
      ]);
    });
  });
});
