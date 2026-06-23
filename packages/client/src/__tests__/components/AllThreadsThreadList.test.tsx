import type { GitStatusInfo, Thread } from '@funny/shared';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { AllThreadsThreadList } from '@/components/all-threads/AllThreadsThreadList';
import { useGitStatusStore } from '@/stores/git-status-store';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    estimateSize,
    getItemKey,
  }: {
    count: number;
    estimateSize: () => number;
    getItemKey: (index: number) => string | number;
  }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey(index),
        start: index * estimateSize(),
      })),
    getTotalSize: () => count * estimateSize(),
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-sidebar-actions', () => ({
  useSidebarActions: () => ({
    archiveConfirm: null,
    setArchiveConfirm: vi.fn(),
    deleteThreadConfirm: null,
    setDeleteThreadConfirm: vi.fn(),
    renameProjectState: null,
    setRenameProjectState: vi.fn(),
    deleteProjectConfirm: null,
    setDeleteProjectConfirm: vi.fn(),
    actionLoading: false,
    issuesProjectId: null,
    setIssuesProjectId: vi.fn(),
    handleArchiveConfirm: vi.fn(),
    handleDeleteThreadConfirm: vi.fn(),
    handleRenameProjectConfirm: vi.fn(),
    handleDeleteProjectConfirm: vi.fn(),
    handleSelectThread: vi.fn(),
    handleArchiveThreadFromList: vi.fn(),
    handleRenameThread: vi.fn(),
    handlePinThread: vi.fn(),
    handleDeleteThreadFromList: vi.fn(),
    branchSwitchDialog: null,
  }),
}));

vi.mock('@/hooks/use-minute-tick', () => ({
  useMinuteTick: () => {},
}));

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    projectId: 'project-1',
    title: 'Fix sidebar search result rows',
    status: 'completed',
    mode: 'local',
    branch: 'main',
    provider: 'claude-sdk',
    cost: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  } as Thread;
}

describe('AllThreadsThreadList', () => {
  beforeEach(() => {
    useGitStatusStore.setState({
      statusByBranch: {},
      threadToBranchKey: {},
      _loadingBranchKeys: new Set(),
    } as any);
  });

  test('uses the sidebar ThreadItem layout with PR badge and menu actions', () => {
    const thread = makeThread();
    const gitStatus: GitStatusInfo = {
      threadId: thread.id,
      branchKey: 'project-1:main',
      state: 'dirty',
      dirtyFileCount: 1,
      unpushedCommitCount: 0,
      unpulledCommitCount: 0,
      hasRemoteBranch: true,
      isMergedIntoBase: false,
      linesAdded: 12,
      linesDeleted: 3,
      prNumber: 42,
      prState: 'OPEN',
      prUrl: 'https://example.test/pull/42',
    };
    useGitStatusStore.setState({
      statusByBranch: { 'project-1:main': gitStatus },
      threadToBranchKey: { [thread.id]: 'project-1:main' },
    } as any);

    renderWithProviders(
      <AllThreadsThreadList
        threads={[thread]}
        search="important"
        caseSensitive={false}
        contentSnippets={new Map([[thread.id, 'An important content match']])}
        emptyMessage="No threads"
        searchEmptyMessage="No matches"
        projectFilter={null}
        projectInfoById={{
          'project-1': { name: 'Funny', path: '/repo/funny', color: '#0ea5e9' },
        }}
        hasMore={false}
        loadingMore={false}
        onEndReached={vi.fn()}
        onSearchKeyDownRef={{ current: null }}
      />,
    );

    expect(screen.getByTestId(`thread-item-${thread.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`thread-item-more-${thread.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`thread-pr-badge-${thread.id}`)).toHaveTextContent('#42');
    expect(screen.getByTestId(`thread-powerline-${thread.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`thread-item-${thread.id}`)).toHaveTextContent(
      /important content match/i,
    );
  });
});
