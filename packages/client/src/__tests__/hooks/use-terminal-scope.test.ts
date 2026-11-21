import { describe, expect, test } from 'bun:test';

import { buildThreadWithMessages } from '@/data/threads/testing';
import { resolveTerminalScope } from '@/hooks/use-terminal-scope';
import { SCRATCH_TERMINAL_SCOPE_ID } from '@/stores/terminal-store';

import { buildMessage } from '../helpers/builders-stores';

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

  test('routes a sandbox thread terminal to its sandbox', () => {
    const sandboxThread = { ...regularThread, id: 'sandbox-thread', runtime: 'sandbox' as const };
    const expected = {
      scopeId: 'grid-project',
      scratchThreadId: null,
      sandboxThreadId: 'sandbox-thread',
      worktreePath: '/worktrees/grid-thread',
    };
    expect(
      resolveTerminalScope({
        liveColumnsOpen: false,
        gridThread: null,
        selectedProjectId: 'grid-project',
        activeThread: sandboxThread,
      }),
    ).toEqual(expected);
    expect(
      resolveTerminalScope({
        liveColumnsOpen: true,
        gridThread: sandboxThread,
        selectedProjectId: null,
        activeThread: null,
      }),
    ).toEqual(expected);
  });

  test('a sandbox thread from another project does not route the selected project terminal', () => {
    expect(
      resolveTerminalScope({
        liveColumnsOpen: false,
        gridThread: null,
        selectedProjectId: 'other-project',
        activeThread: { ...regularThread, runtime: 'sandbox' as const },
      }).sandboxThreadId,
    ).toBeUndefined();
  });
});

describe('useTerminalScope subscriptions', () => {
  test('does not re-render when only the open thread messages change', async () => {
    const { act, renderHook } = await import('@testing-library/react');
    const { useTerminalScope } = await import('@/hooks/use-terminal-scope');
    const { useThreadStore } = await import('@/stores/thread-store');
    const base = buildThreadWithMessages({
      id: 'active-thread',
      projectId: 'p1',
      isScratch: false,
      worktreePath: '/worktrees/active-thread',
    });
    act(() => useThreadStore.setState({ activeThread: base }));

    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useTerminalScope();
    });
    expect(result.current.scopeId).toBe('p1');
    const before = renders;

    act(() =>
      useThreadStore.setState({
        activeThread: { ...base, messages: [buildMessage({ id: 'm1', content: 'streamed' })] },
      }),
    );
    expect(renders).toBe(before);

    act(() =>
      useThreadStore.setState({
        activeThread: { ...base, worktreePath: '/worktrees/moved' },
      }),
    );
    expect(renders).toBe(before + 1);
    expect(result.current.worktreePath).toBe('/worktrees/moved');
  });
});
