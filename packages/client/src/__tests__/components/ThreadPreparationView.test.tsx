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

  test('a failed early step is shown with its error, not the last pending step', () => {
    renderWithProviders(
      <ThreadPreparationView
        prompt="dame un resumen"
        steps={[
          {
            id: 'machine',
            label: 'Creating sandbox',
            status: 'failed',
            error: 'Trial accounts can run 2 concurrent sandboxes.',
          },
          { id: 'runner', label: 'Installing runner', status: 'pending' },
          { id: 'agent', label: 'Starting agent', status: 'pending' },
        ]}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Creating sandbox');
    expect(status).toHaveTextContent('Trial accounts can run 2 concurrent sandboxes.');
    expect(status).not.toHaveTextContent('Starting agent');
    expect(screen.getByTestId('thread-preparation-failed')).toBeInTheDocument();
  });
});
