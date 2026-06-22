import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { CommitActionsMenu } from '@/components/commit-graph/CommitActionsMenu';

import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallbackOrOpts?: string | Record<string, any>) =>
      typeof fallbackOrOpts === 'string' ? fallbackOrOpts : fallbackOrOpts?.defaultValue || _key,
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('CommitActionsMenu', () => {
  const rebaseEvent = {
    id: 'rebase-1',
    kind: 'rebase' as const,
    label: 'rebase',
    branch: 'feature/auth',
    onto: 'main',
    startedAt: '2026-06-20T19:51:20-06:00',
    finishedAt: '2026-06-20T20:17:55-06:00',
    startHash: 'aaa111',
    startShortHash: 'aaa111',
    finishHash: '1111111111111111111111111111111111111111',
    finishShortHash: '1111111',
    completed: true,
    steps: [],
    commitHashes: ['1111111111111111111111111111111111111111'],
    commitPairs: [],
  };

  test('shows GitHub action when a remote commit URL is available', () => {
    renderWithProviders(
      <CommitActionsMenu
        hash="1111111111111111111111111111111111111111"
        shortHash="1111111"
        githubUrl="https://github.com/acme/funny/commit/1111111111111111111111111111111111111111"
        projectModeId={null}
        onAfterAction={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByTestId('graph-commit-more-1111111'), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.getByTestId('graph-commit-menu-github-1111111')).toBeInTheDocument();
  });

  test('hides GitHub action when the commit is local-only', () => {
    renderWithProviders(
      <CommitActionsMenu
        hash="1111111111111111111111111111111111111111"
        shortHash="1111111"
        githubUrl={null}
        projectModeId={null}
        onAfterAction={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByTestId('graph-commit-more-1111111'), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.queryByTestId('graph-commit-menu-github-1111111')).not.toBeInTheDocument();
  });

  test('shows rebase details action when the row has rebase metadata', () => {
    const onSelectRebaseEvent = vi.fn();
    renderWithProviders(
      <CommitActionsMenu
        hash="1111111111111111111111111111111111111111"
        shortHash="1111111"
        githubUrl={null}
        projectModeId={null}
        rebaseEvents={[rebaseEvent]}
        onSelectRebaseEvent={onSelectRebaseEvent}
        onAfterAction={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByTestId('graph-commit-more-1111111'), {
      button: 0,
      ctrlKey: false,
    });

    const item = screen.getByTestId('graph-commit-menu-rebase-details-1111111');
    expect(item).toHaveTextContent('View rebase details: feature/auth -> main');

    fireEvent.click(item);

    expect(onSelectRebaseEvent).toHaveBeenCalledWith(rebaseEvent);
  });

  test('shows merge and rebase actions for target branches', () => {
    renderWithProviders(
      <CommitActionsMenu
        hash="1111111111111111111111111111111111111111"
        shortHash="1111111"
        githubUrl={null}
        projectModeId="p1"
        targetBranches={['master']}
        onAfterAction={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByTestId('graph-commit-more-1111111'), {
      button: 0,
      ctrlKey: false,
    });

    expect(screen.getByTestId('graph-commit-menu-merge-current-into-master')).toHaveTextContent(
      'Merge current branch into master',
    );
    expect(screen.getByTestId('graph-commit-menu-rebase-current-onto-master')).toHaveTextContent(
      'Rebase current branch onto master',
    );
  });
});
