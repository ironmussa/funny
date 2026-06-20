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
});
