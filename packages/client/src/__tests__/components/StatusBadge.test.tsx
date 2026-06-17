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
  initReactI18next: { type: '3rdParty', init: () => {} },
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

  test('shows spin animation for running status', () => {
    const { container } = renderWithProviders(<StatusBadge status="running" />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  test('does not animate the waiting status', () => {
    const { container } = renderWithProviders(<StatusBadge status="waiting" />);
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  test('does not animate the completed status', () => {
    const { container } = renderWithProviders(<StatusBadge status="completed" />);
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });
});
