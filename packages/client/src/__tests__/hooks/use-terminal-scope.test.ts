import { describe, expect, test } from 'vitest';

import { resolveTerminalScope } from '@/hooks/use-terminal-scope';
import { SCRATCH_TERMINAL_SCOPE_ID } from '@/stores/terminal-store';

const regularThread = {
  id: 'grid-thread',
  projectId: 'grid-project',
  isScratch: false,
  worktreePath: '/worktrees/grid-thread',
};

describe('resolveTerminalScope', () => {
  test('uses the selected split thread instead of the stale regular-view project', () => {
    expect(
      resolveTerminalScope({
        liveColumnsOpen: true,
        gridThread: regularThread,
        selectedProjectId: 'stale-project',
        activeThread: {
          id: 'stale-thread',
          projectId: 'stale-project',
          isScratch: false,
          worktreePath: '/worktrees/stale-thread',
        },
      }),
    ).toEqual({
      scopeId: 'grid-project',
      scratchThreadId: null,
      worktreePath: '/worktrees/grid-thread',
    });
  });

  test('does not fall back to stale context when no split is selected', () => {
    expect(
      resolveTerminalScope({
        liveColumnsOpen: true,
        gridThread: null,
        selectedProjectId: 'stale-project',
        activeThread: regularThread,
      }),
    ).toEqual({ scopeId: null, scratchThreadId: null, worktreePath: null });
  });

  test('preserves scratch routing for a selected split thread', () => {
    expect(
      resolveTerminalScope({
        liveColumnsOpen: true,
        gridThread: {
          id: 'scratch-thread',
          projectId: '',
          isScratch: true,
          worktreePath: undefined,
        },
        selectedProjectId: 'stale-project',
        activeThread: null,
      }),
    ).toEqual({
      scopeId: SCRATCH_TERMINAL_SCOPE_ID,
      scratchThreadId: 'scratch-thread',
      worktreePath: null,
    });
  });
});

describe('useTerminalScope subscriptions', () => {
  test('does not re-render when only the open thread messages change', async () => {
    const { act, renderHook } = await import('@testing-library/react');
    const { useTerminalScope } = await import('@/hooks/use-terminal-scope');
    const { useThreadStore } = await import('@/stores/thread-store');
    const base = {
      id: 'active-thread',
      projectId: 'p1',
      isScratch: false,
      worktreePath: '/worktrees/active-thread',
      messages: [] as any[],
    };
    act(() => useThreadStore.setState({ activeThread: base as any }));

    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useTerminalScope();
    });
    expect(result.current.scopeId).toBe('p1');
    const before = renders;

    act(() =>
      useThreadStore.setState({
        activeThread: { ...base, messages: [{ id: 'm1', content: 'streamed' }] } as any,
      }),
    );
    expect(renders).toBe(before);

    act(() =>
      useThreadStore.setState({
        activeThread: { ...base, worktreePath: '/worktrees/moved' } as any,
      }),
    );
    expect(renders).toBe(before + 1);
    expect(result.current.worktreePath).toBe('/worktrees/moved');
  });
});
