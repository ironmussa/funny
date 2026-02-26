import type { ThreadStatus } from '@funny/shared';
import { screen } from '@testing-library/react';
import { describe, test, expect, vi } from 'vitest';

import { StatusBadge } from '@/components/StatusBadge';

import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

describe('StatusBadge', () => {
  const statuses: ThreadStatus[] = [
    'idle',
    'pending',
    'running',
    'waiting',
    'completed',
    'failed',
    'stopped',
    'interrupted',
  ];

  test.each(statuses)('renders badge for status "%s"', (status) => {
    renderWithProviders(<StatusBadge status={status} />);
    const badge = screen.getByText((content) => {
      // The badge renders a status label from getStatusLabels(t)
      // Since t returns the key, it will be like 'thread.status.xxx' or 'thread.status.done'
      return content.length > 0;
    });
    expect(badge).toBeInTheDocument();
  });

  test('shows animated pulse for running status', () => {
    const { container } = renderWithProviders(<StatusBadge status="running" />);
    const pulse = container.querySelector('.animate-pulse');
    expect(pulse).not.toBeNull();
  });

  test('shows animated pulse for waiting status', () => {
    const { container } = renderWithProviders(<StatusBadge status="waiting" />);
    const pulse = container.querySelector('.animate-pulse');
    expect(pulse).not.toBeNull();
  });

  test('does not show pulse for completed status', () => {
    const { container } = renderWithProviders(<StatusBadge status="completed" />);
    const pulse = container.querySelector('.animate-pulse');
    expect(pulse).toBeNull();
  });
});
