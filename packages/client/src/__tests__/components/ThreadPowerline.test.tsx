import type { GitStatusInfo, Thread } from '@funny/shared';
import { fireEvent, screen } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';

import { ThreadPowerline } from '@/components/ThreadPowerline';

import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

/** Minimal thread mock — only the fields ThreadPowerline reads. */
function mockThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread-1',
    projectId: 'proj-1',
    userId: 'user-1',
    title: 'Test thread',
    mode: 'local',
    status: 'idle',
    stage: 'idle',
    provider: 'claude-sdk',
    permissionMode: 'default',
    model: 'sonnet',
    cost: 0,
    source: 'manual',
    runtime: 'local',
    ...overrides,
  } as Thread;
}

describe('ThreadPowerline', () => {
  test('worktree thread shows distinct base-branch and worktree segments', () => {
    renderWithProviders(
      <ThreadPowerline
        thread={mockThread({ mode: 'worktree', baseBranch: 'master', branch: 'funny/feat-x' })}
        projectName="funny"
      />,
    );

    expect(screen.getByTestId('powerline-segment-project')).toBeInTheDocument();
    expect(screen.getByTestId('powerline-segment-branch')).toHaveTextContent('master');
    expect(screen.getByTestId('powerline-segment-worktree-branch')).toHaveTextContent(
      'funny/feat-x',
    );
  });

  test('collapses the base-branch segment when it equals the worktree branch', () => {
    // Regression: ingested threads default baseBranch to branch, which previously
    // rendered two identical segments (project › branch › branch).
    const dup = 'backend-v2/gol-778-throttle-webhooks-pasarela-JcNTvG';
    renderWithProviders(
      <ThreadPowerline
        thread={mockThread({ mode: 'worktree', baseBranch: dup, branch: dup })}
        projectName="backend-v2"
      />,
    );

    // No redundant base-branch segment — only the worktree branch remains.
    expect(screen.queryByTestId('powerline-segment-branch')).not.toBeInTheDocument();
    expect(screen.getByTestId('powerline-segment-worktree-branch')).toHaveTextContent(dup);
    expect(screen.getByTestId('powerline-segment-project')).toHaveTextContent('backend-v2');
  });

  test('DiffStats chip fires onDiffStatsClick (opens review pane)', () => {
    const gitStatus: GitStatusInfo = {
      threadId: 'thread-1',
      branchKey: 'thread-1:master',
      state: 'dirty',
      dirtyFileCount: 21,
      unpushedCommitCount: 0,
      unpulledCommitCount: 0,
      hasRemoteBranch: false,
      isMergedIntoBase: false,
      linesAdded: 704,
      linesDeleted: 115,
    };
    const onDiffStatsClick = vi.fn();
    renderWithProviders(
      <ThreadPowerline
        thread={mockThread({ mode: 'local', baseBranch: 'master' })}
        projectName="funny"
        gitStatus={gitStatus}
        onDiffStatsClick={onDiffStatsClick}
      />,
    );

    fireEvent.click(screen.getByTestId('prompt-powerline-diffstats'));
    expect(onDiffStatsClick).toHaveBeenCalledTimes(1);
  });

  test('local thread keeps its single branch segment', () => {
    renderWithProviders(
      <ThreadPowerline
        thread={mockThread({ mode: 'local', baseBranch: 'master' })}
        projectName="funny"
      />,
    );

    expect(screen.getByTestId('powerline-segment-branch')).toHaveTextContent('master');
    expect(screen.queryByTestId('powerline-segment-worktree-branch')).not.toBeInTheDocument();
  });
});
