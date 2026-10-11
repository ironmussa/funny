import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { TeamMembers } from '@/components/settings/TeamMembers';
import { TooltipProvider } from '@/components/ui/tooltip';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => null }));
vi.mock('@/lib/auth-client', () => ({
  authClient: {
    organization: {
      listMembers: async () => ({ data: [] }),
      listInvitations: async () => ({ data: [] }),
    },
  },
}));
vi.mock('@/lib/api', () => ({
  api: {
    getSmtpSettings: async () => ({ isOk: () => true, value: { configured: true } }),
    listInviteLinks: async () => ({
      isOk: () => true,
      value: [
        { id: 'expiring', expiresAt: '2026-01-01T00:00:30Z', maxUses: null, useCount: 0 },
        { id: 'expired', expiresAt: '2025-12-31T23:59:00Z', maxUses: null, useCount: 0 },
        { id: 'unlimited', expiresAt: null, maxUses: null, useCount: 0 },
        { id: 'maxed', expiresAt: null, maxUses: 1, useCount: 1 },
      ].map((link) => ({ ...link, token: link.id, role: 'member', createdAt: '2025-12-31' })),
    }),
  },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('refreshes invitation expiry on the shared clock and preserves usage limits', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  await act(async () => {
    render(
      <TooltipProvider>
        <TeamMembers />
      </TooltipProvider>,
    );
  });

  expect(screen.getByTestId('team-link-copy-expiring')).toBeEnabled();
  expect(screen.getByTestId('team-link-copy-unlimited')).toBeEnabled();
  expect(screen.getByTestId('team-link-copy-expired')).toBeDisabled();
  expect(screen.getByTestId('team-link-copy-maxed')).toBeDisabled();
  expect(within(screen.getByTestId('team-link-maxed')).getByText('maxed')).toBeInTheDocument();

  act(() => vi.advanceTimersByTime(60_000));

  expect(screen.getByTestId('team-link-copy-expiring')).toBeDisabled();
  expect(within(screen.getByTestId('team-link-expiring')).getByText('expired')).toBeInTheDocument();
  expect(screen.getByTestId('team-link-copy-unlimited')).toBeEnabled();
});
