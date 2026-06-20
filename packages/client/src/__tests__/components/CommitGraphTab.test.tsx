import { screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { GraphCommitTime } from '@/components/CommitGraphTab';

import { renderWithProviders } from '../helpers/render';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallbackOrOpts?: string | Record<string, any>) =>
      typeof fallbackOrOpts === 'string' ? fallbackOrOpts : fallbackOrOpts?.defaultValue || _key,
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('GraphCommitTime', () => {
  test('shows an unpushed arrow next to the commit date for local-only commits', () => {
    renderWithProviders(
      <GraphCommitTime relativeDate="13 minutes ago" unpushed shortHash="1111111" />,
    );

    expect(screen.getByText('13m')).toBeInTheDocument();
    expect(screen.getByTestId('graph-unpushed-1111111')).toBeInTheDocument();
    expect(screen.getByTestId('graph-unpushed-icon-1111111')).toHaveClass('lucide-circle-arrow-up');
    expect(screen.getByTestId('graph-unpushed-icon-1111111')).toHaveClass('icon-sm');
    expect(screen.getByTestId('graph-unpushed-icon-1111111')).toHaveClass(
      '[&_circle]:fill-current',
    );
    expect(screen.getByTestId('graph-unpushed-icon-1111111')).toHaveClass(
      '[&_path]:stroke-primary-foreground',
    );
  });

  test('does not show an unpushed arrow for remote commits', () => {
    renderWithProviders(
      <GraphCommitTime relativeDate="13 minutes ago" unpushed={false} shortHash="1111111" />,
    );

    expect(screen.getByText('13m')).toBeInTheDocument();
    expect(screen.queryByTestId('graph-unpushed-1111111')).not.toBeInTheDocument();
  });
});
