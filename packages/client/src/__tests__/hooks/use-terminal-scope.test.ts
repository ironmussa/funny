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
