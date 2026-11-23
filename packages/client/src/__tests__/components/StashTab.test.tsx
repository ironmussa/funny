import { describe, expect, test, vi, mock } from 'bun:test';

import { fireEvent, screen } from '@testing-library/react';

import { StashTab } from '@/components/review-pane/StashTab';
import { stashBranch, type UseStashStateResult } from '@/hooks/use-stash-state';
import {
  listRowActionBusyClassName,
  listRowActionClassName,
  listRowClassName,
} from '@/lib/list-row-styles';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

function stashState(overrides: Partial<UseStashStateResult> = {}): UseStashStateResult {
  const entries = [{ index: 'stash@{0}', message: 'On main: wip', createdAt: Date.now() }];
  return {
    stashEntries: entries,
    filteredStashEntries: entries,
    otherBranchStashGroups: [],
    selectedStashIndex: null,
    setSelectedStashIndex: vi.fn(),
    selectedStashEntry: null,
    stashFiles: [],
    stashTreeFiles: [],
    stashFilesLoading: false,
    stashListLoading: false,
    stashDialogFile: null,
    stashDialogDiff: null,
    stashDialogDiffLoading: false,
    stashDialogDiffCache: new Map(),
    stashFileSearch: '',
    setStashFileSearch: vi.fn(),
    stashFileSearchCaseSensitive: false,
    setStashFileSearchCaseSensitive: vi.fn(),
    stashPopInProgress: false,
    stashDropInProgress: null,
    handleStashPop: vi.fn(async () => {}),
    executeStashDrop: vi.fn(async () => {}),
    loadStashFileDiff: vi.fn(async () => {}),
    refreshStashList: vi.fn(async () => {}),
    ...overrides,
  };
}

function renderStash(overrides?: Partial<UseStashStateResult>) {
  return renderWithProviders(
    <StashTab
      stash={stashState(overrides)}
      currentBranch="main"
      isAgentRunning={false}
      onRequestDrop={vi.fn()}
    />,
  );
}

describe('StashTab rows', () => {
  test('use the shared list row and hide their actions until hover', () => {
    renderStash();

    const row = screen.getByTestId('stash-entry-0');
    for (const cls of listRowClassName.split(' ')) expect(row).toHaveClass(cls);

    // The discard button swaps the hover color for red; the reveal-on-hover classes are shared.
    const reveal = listRowActionClassName.split(' ').filter((cls) => cls.includes('opacity'));
    for (const testId of ['stash-pop-0', 'stash-drop-0']) {
      const action = screen.getByTestId(testId);
      for (const cls of reveal) expect(action).toHaveClass(cls);
    }
  });

  test('keeps a running action visible while it works', () => {
    renderStash({ stashDropInProgress: '0' });

    const drop = screen.getByTestId('stash-drop-0');
    expect(drop).toBeDisabled();
    for (const cls of listRowActionBusyClassName.split(' ')) expect(drop).toHaveClass(cls);
  });

  test('a disabled action stays hidden until hover instead of showing dimmed', () => {
    // The pop is disabled while an agent runs; the Button's `disabled:opacity-50`
    // used to beat `opacity-0` and leave it on screen.
    renderWithProviders(
      <StashTab stash={stashState()} currentBranch="main" isAgentRunning onRequestDrop={vi.fn()} />,
    );

    for (const testId of ['stash-pop-0', 'stash-drop-0']) {
      const action = screen.getByTestId(testId);
      expect(action).toBeDisabled();
      expect(action).toHaveClass('disabled:opacity-0', 'group-hover:disabled:opacity-50');
      expect(action).not.toHaveClass('disabled:opacity-50');
    }
  });
});

describe('StashTab other branches', () => {
  const other = {
    index: 'stash@{0}',
    message: 'WIP on feat/x: abc123 work',
    createdAt: Date.now(),
  };

  test('lists every stash in one list, marking the current branch with a chip', () => {
    const mine = { index: 'stash@{0}', message: 'On main: wip', createdAt: Date.now() };
    const theirs = { ...other, index: 'stash@{1}' };
    renderStash({
      stashEntries: [mine, theirs],
      filteredStashEntries: [mine],
      otherBranchStashGroups: [{ branch: 'feat/x', entries: [theirs] }],
    });

    const list = screen.getByTestId('stash-list');
    expect(list).toContainElement(screen.getByTestId('stash-entry-0'));
    expect(list).toContainElement(screen.getByTestId('stash-entry-1'));
    // Each row names its branch; only the checked-out one is Current.
    expect(screen.getByTestId('stash-branch-0')).toHaveTextContent('main');
    expect(screen.getByTestId('stash-current-0')).toHaveTextContent('Current');
    expect(screen.getByTestId('stash-branch-1')).toHaveTextContent('feat/x');
    expect(screen.queryByTestId('stash-current-1')).not.toBeInTheDocument();
    // git's "On <branch>:" prefix is dropped from the title, since the row shows the branch.
    expect(screen.getByTestId('stash-entry-0')).toHaveTextContent('wip');
    expect(screen.getByTestId('stash-entry-0')).not.toHaveTextContent('On main:');
    expect(screen.queryByText('Other branches')).not.toBeInTheDocument();
  });

  test('cannot pop a stash made on another branch, even the latest', () => {
    const onPop = vi.fn(async () => {});
    renderStash({
      handleStashPop: onPop,
      stashEntries: [other],
      filteredStashEntries: [],
      otherBranchStashGroups: [{ branch: 'feat/x', entries: [other] }],
    });

    const pop = screen.getByTestId('stash-pop-0');
    // Blocked, not disabled: it keeps its color and its tooltip explains why.
    expect(pop).toHaveAttribute('aria-disabled', 'true');
    expect(pop).toHaveAccessibleName('Made on feat/x: switch to that branch to pop it');
    fireEvent.click(pop);
    expect(onPop).not.toHaveBeenCalled();
    expect(screen.getByTestId('stash-drop-0')).toBeEnabled();
  });

  test('shows the plain empty state when there are no stashes at all', () => {
    renderStash({ stashEntries: [], filteredStashEntries: [] });

    expect(screen.queryByTestId('stash-list')).not.toBeInTheDocument();
    expect(screen.getByText('No stashed changes on main')).toBeInTheDocument();
  });
});

describe('stashBranch', () => {
  test('reads the branch from both stash message forms', () => {
    expect(stashBranch('On main: wip')).toBe('main');
    expect(stashBranch('WIP on feat/x: abc123 msg')).toBe('feat/x');
    expect(stashBranch('autostash')).toBeNull();
  });
});

describe('StashTab toolbar', () => {
  test('refresh re-reads the stash list and the count shows every stash', () => {
    const refreshStashList = vi.fn(async () => {});
    renderStash({ refreshStashList });

    expect(screen.getByTestId('stash-count')).toHaveTextContent('review.toolbarCount.stashes:1');
    fireEvent.click(screen.getByTestId('stash-refresh'));
    expect(refreshStashList).toHaveBeenCalledTimes(1);
  });

  test('keeps the toolbar when there are no stashes', () => {
    renderStash({ stashEntries: [], filteredStashEntries: [] });

    expect(screen.getByTestId('stash-refresh')).toBeInTheDocument();
    expect(screen.getByTestId('stash-count')).toHaveTextContent('review.toolbarCount.stashes:0');
  });

  test('disables refresh while the list loads', () => {
    renderStash({ stashListLoading: true });
    expect(screen.getByTestId('stash-refresh')).toBeDisabled();
  });
});
