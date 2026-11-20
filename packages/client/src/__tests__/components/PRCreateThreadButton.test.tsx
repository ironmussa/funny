import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { PRCreateThreadButton } from '@/components/pull-requests/PRCreateThreadButton';

import { renderWithProviders } from '../helpers/render';

describe('PRCreateThreadButton', () => {
  test('is a single icon button (no menu) that starts a thread on the head branch', () => {
    const onCreateThread = vi.fn();
    renderWithProviders(
      <PRCreateThreadButton prNumber={7} branch="feat/x" onCreateThread={onCreateThread} />,
    );

    const button = screen.getByTestId('pr-create-thread-7');
    expect(button).toHaveAccessibleName('New thread from branch');
    expect(button).not.toHaveAttribute('aria-haspopup');
    fireEvent.click(button);
    expect(onCreateThread).toHaveBeenCalledWith('feat/x');
  });

  test('renders nothing when the pull request has no branch', () => {
    renderWithProviders(
      <PRCreateThreadButton prNumber={7} branch={null} onCreateThread={vi.fn()} />,
    );

    expect(screen.queryByTestId('pr-create-thread-7')).not.toBeInTheDocument();
  });
});
