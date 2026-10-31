import { screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { ThreadPreparationView } from '@/components/thread/ThreadPreparationView';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('@/components/PromptInput', () => ({
  PromptInput: () => <button type="button">Send follow-up</button>,
}));

describe('ThreadPreparationView', () => {
  test('keeps the prompt and disabled follow-up visible while worktree setup progresses', () => {
    renderWithProviders(
      <ThreadPreparationView
        prompt="Fix the bug"
        steps={[{ id: 'clone', label: 'Creating worktree', status: 'running' }]}
      />,
    );
    expect(screen.getByText('Fix the bug')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Creating worktree');
    expect(screen.getByRole('button', { name: 'Send follow-up' })).toBeDisabled();
  });

  test('shows setup errors alongside the submitted prompt', () => {
    renderWithProviders(
      <ThreadPreparationView
        prompt="Fix the bug"
        steps={[{ id: 'clone', label: 'Creating worktree', status: 'failed', error: 'Disk full' }]}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Disk full');
    expect(screen.getByText('Fix the bug')).toBeInTheDocument();
  });
});
