import { describe, expect, test, setSystemTime, vi, mock } from 'bun:test';

import { screen } from '@testing-library/react';

import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: mockT }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
mock.module('@/components/PromptInput', () => ({
  PromptInput: (props: {
    loading?: boolean;
    onSubmit: (prompt: string, opts: Record<string, unknown>) => void;
  }) => (
    <button
      type="button"
      data-loading={String(Boolean(props.loading))}
      onClick={() => props.onSubmit('try again', {})}
    >
      Send follow-up
    </button>
  ),
}));

const { ThreadPreparationView } = await import('@/components/thread/ThreadPreparationView');

describe('ThreadPreparationView', () => {
  test('shows the time elapsed since the prompt was sent while preparing', () => {
    vi.useFakeTimers();
    try {
      setSystemTime(new Date('2026-11-17T10:00:07.000Z'));
      renderWithProviders(
        <ThreadPreparationView
          prompt="hola"
          metadata={{ timestamp: '2026-11-17T10:00:00.000Z' }}
        />,
      );
      expect(screen.getByTestId('agent-working-elapsed')).toHaveTextContent('(duration.seconds:7)');
    } finally {
      vi.useRealTimers();
    }
  });

  test('hides the elapsed time once preparation failed', () => {
    renderWithProviders(
      <ThreadPreparationView
        prompt="Fix the bug"
        steps={[{ id: 'clone', label: 'Creating worktree', status: 'failed', error: 'Disk full' }]}
      />,
    );
    expect(screen.queryByTestId('agent-working-elapsed')).not.toBeInTheDocument();
  });

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

  test('a retryable failure enables the prompt dock and submits through onRetry', () => {
    const onRetry = vi.fn(async () => true);
    renderWithProviders(
      <ThreadPreparationView
        prompt="Fix the bug"
        steps={[{ id: 'machine', label: 'Creating sandbox', status: 'failed', error: 'timed out' }]}
        onRetry={onRetry}
      />,
    );
    const send = screen.getByRole('button', { name: 'Send follow-up' });
    expect(send).not.toBeDisabled();
    expect(send).toHaveAttribute('data-loading', 'false');
    send.click();
    expect(onRetry).toHaveBeenCalledWith('try again', {});
  });

  test('the prompt dock shows loading while the retry is in flight', () => {
    renderWithProviders(<ThreadPreparationView prompt="Fix the bug" onRetry={vi.fn()} retrying />);
    expect(screen.getByRole('button', { name: 'Send follow-up' })).toHaveAttribute(
      'data-loading',
      'true',
    );
  });
});
