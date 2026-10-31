import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WorktreeSetupProgress } from '@/components/WorktreeSetupProgress';

vi.mock('@/components/GitProgressModal', () => ({
  useStepTimers: () => () => 5,
  useTotalFromSteps: () => 12,
  formatElapsed: (seconds: number) => `${seconds}s`,
}));

const step = (
  id: string,
  status: 'pending' | 'running' | 'completed' | 'failed',
  error?: string,
) => ({ id, label: id, status, error });

describe('WorktreeSetupProgress', () => {
  it('shows preparation before any step arrives', () => {
    render(<WorktreeSetupProgress steps={[]} />);
    expect(screen.getByText('Preparing…')).toBeInTheDocument();
  });

  it('focuses the running step ahead of completed and pending steps', () => {
    render(
      <WorktreeSetupProgress
        steps={[step('clone', 'completed'), step('install', 'running'), step('start', 'pending')]}
      />,
    );
    expect(screen.getByTestId('worktree-setup-step-install')).toHaveTextContent('5s');
    expect(screen.getByTestId('worktree-setup-dots').children).toHaveLength(3);
    expect(screen.queryByText('Completed in 12s')).not.toBeInTheDocument();
  });

  it('shows the latest finished step and its error when execution fails', () => {
    render(
      <WorktreeSetupProgress
        steps={[step('clone', 'completed'), step('install', 'failed', 'Install failed')]}
      />,
    );
    expect(screen.getByTestId('worktree-setup-step-install')).toHaveTextContent('Install failed');
  });

  it('shows completion duration when every step finished successfully', () => {
    render(
      <WorktreeSetupProgress steps={[step('clone', 'completed'), step('install', 'completed')]} />,
    );
    expect(screen.getByTestId('worktree-setup-step-install')).toBeInTheDocument();
    expect(screen.getByText('Completed in 12s')).toBeInTheDocument();
  });

  it('shows the first pending step without an elapsed timer', () => {
    render(<WorktreeSetupProgress steps={[step('clone', 'pending')]} />);
    expect(screen.getByTestId('worktree-setup-step-clone')).not.toHaveTextContent('5s');
    expect(screen.queryByTestId('worktree-setup-dots')).not.toBeInTheDocument();
  });
});
