import type { GitStatusInfo, Thread } from '@funny/shared';
import { fireEvent, screen } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';

import { ThreadPowerline } from '@/components/ThreadPowerline';

import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const templates: Record<string, string> = {
        'powerline.tooltipLocalBranch': 'Local branch: {{branch}}',
        'powerline.tooltipBaseBranch': 'Base branch: {{branch}}',
        'powerline.tooltipWorktree': 'Worktree branch: {{branch}}',
        'powerline.tooltipWorktreeWithPath': 'Worktree branch: {{branch}} — {{path}}',
      };
      return Object.entries(values ?? {}).reduce(
        (message, [name, value]) => message.replaceAll(`{{${name}}}`, value),
        templates[key] ?? key,
      );
    },
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

  test('renders the PR badge when gitStatus carries PR metadata', () => {
    // Regression: the PR number showed in surfaces with their own PRBadge
    // (sidebar, Activity) but not in the shared ThreadPowerline (prompt footer,
    // Kanban, ThreadPicker). A clean branch with an open PR must still show it.
    const gitStatus: GitStatusInfo = {
      threadId: 'thread-1',
      branchKey: 'thread-1:master',
      state: 'clean',
      dirtyFileCount: 0,
      unpushedCommitCount: 0,
      unpulledCommitCount: 0,
      hasRemoteBranch: true,
      isMergedIntoBase: false,
      linesAdded: 0,
      linesDeleted: 0,
      prNumber: 51,
      prState: 'OPEN',
      prUrl: 'https://github.com/org/repo/pull/51',
    };
    renderWithProviders(
      <ThreadPowerline
        thread={mockThread({ mode: 'local', baseBranch: 'master' })}
        projectName="funny"
        gitStatus={gitStatus}
        prBadgeTestId="thread-pr-badge-thread-1"
      />,
    );

    const badge = screen.getByTestId('thread-pr-badge-thread-1');
    expect(badge).toHaveTextContent('#51');
    expect(badge).toHaveAttribute('href', 'https://github.com/org/repo/pull/51');
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

  test('local branch tooltip includes the full branch name', async () => {
    const branch = 'goliiive/v2/argenisleon/gol-782-seclow-d4-s3-key-injection-via-typ';
    renderWithProviders(
      <ThreadPowerline
        thread={mockThread({ mode: 'local', baseBranch: branch })}
        projectName="goliiive-v2"
      />,
    );

    fireEvent.pointerMove(screen.getByTestId('powerline-segment-branch'), {
      pointerType: 'mouse',
    });

    expect(await screen.findAllByText(`Local branch: ${branch}`)).not.toHaveLength(0);
  });

  test('worktree branch tooltip includes the full branch name', async () => {
    const branch = 'goliiive-v2/argenisleon/gol-782-seclow-d4-s3-key-injection-via-typ';
    renderWithProviders(
      <ThreadPowerline
        thread={mockThread({
          mode: 'worktree',
          baseBranch: 'main',
          branch,
          worktreePath: '/home/user/.funny-worktrees/goliiive-v2-worktree',
        })}
        projectName="goliiive-v2"
      />,
    );

    fireEvent.pointerMove(screen.getByTestId('powerline-segment-worktree-branch'), {
      pointerType: 'mouse',
    });

    expect(
      await screen.findAllByText(`Worktree branch: ${branch} — goliiive-v2-worktree`),
    ).not.toHaveLength(0);
  });
});
