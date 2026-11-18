import { screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { StashTab } from '@/components/review-pane/StashTab';
import type { UseStashStateResult } from '@/hooks/use-stash-state';
import { listRowActionClassName, listRowClassName } from '@/lib/list-row-styles';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

function stashState(overrides: Partial<UseStashStateResult> = {}): UseStashStateResult {
  const entries = [{ index: 'stash@{0}', message: 'On main: wip', createdAt: Date.now() }];
  return {
    stashEntries: entries,
    filteredStashEntries: entries,
    selectedStashIndex: null,
    setSelectedStashIndex: vi.fn(),
    selectedStashEntry: null,
    stashFiles: [],
    stashTreeFiles: [],
    stashFilesLoading: false,
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

    expect(screen.getByTestId('stash-drop-0')).toHaveClass('opacity-100');
  });
});
