import { beforeEach, describe, expect, test } from 'vitest';

import { openScopeTerminal } from '@/lib/open-terminal-tab';
import {
  SCRATCH_TERMINAL_SCOPE_ID,
  tabSandboxThreadId,
  useTerminalStore,
} from '@/stores/terminal-store';

beforeEach(() => {
  useTerminalStore.setState({ tabs: [], activeTabId: null, panelVisibleByProject: {} });
});

const onlyTab = () => useTerminalStore.getState().tabs[0]!;

describe('openScopeTerminal', () => {
  test("a sandbox thread's terminal opens on its sandbox", () => {
    openScopeTerminal(
      {
        scopeId: 'p1',
        scratchThreadId: null,
        sandboxThreadId: 't-box',
        worktreePath: '/repo/.worktrees/t-box',
      },
      'default',
    );
    expect(onlyTab()).toMatchObject({
      projectId: 'p1',
      cwd: '/repo/.worktrees/t-box',
      sandboxThreadId: 't-box',
    });
    // The spawn reads it back by tab id (see WebTerminalTabContent).
    expect(tabSandboxThreadId(onlyTab().id)).toBe('t-box');
    expect(useTerminalStore.getState().panelVisibleByProject.p1).toBe(true);
  });

  test('a local thread terminal carries no sandbox', () => {
    openScopeTerminal({ scopeId: 'p1', scratchThreadId: null, worktreePath: '/repo' }, 'default');
    expect(onlyTab().sandboxThreadId).toBeUndefined();
    expect(tabSandboxThreadId(onlyTab().id)).toBeUndefined();
  });

  test('a scratch terminal keeps its scratch thread', () => {
    openScopeTerminal(
      { scopeId: SCRATCH_TERMINAL_SCOPE_ID, scratchThreadId: 's1', worktreePath: null },
      'default',
    );
    expect(onlyTab()).toMatchObject({ cwd: '~', scratchThreadId: 's1' });
  });
});
