import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { mockT } from '../helpers/mock-i18n';

const mocks = vi.hoisted(() => ({
  listPersonalTokens: vi.fn(),
  createPersonalToken: vi.fn(),
  revokePersonalToken: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', () => ({ api: mocks }));

import { ApiTokensSettings } from '@/components/settings/ApiTokensSettings';
import { TooltipProvider } from '@/components/ui/tooltip';

const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

const active = {
  id: 'k1',
  name: 'CI deploy',
  prefix: 'funny_pat_abc123',
  createdAt: past,
  expiresAt: future,
};
const revoked = { ...active, id: 'k2', name: 'Old', revokedAt: past };

const renderSettings = () =>
  render(
    <TooltipProvider>
      <ApiTokensSettings />
    </TooltipProvider>,
  );

describe('ApiTokensSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('lists tokens with their prefix and revoked state', async () => {
    mocks.listPersonalTokens.mockReturnValue(okAsync([active, revoked]));
    renderSettings();

    const item = await screen.findByTestId('settings-api-tokens-item-k1');
    expect(item).toHaveTextContent('CI deploy');
    expect(item).toHaveTextContent('funny_pat_abc123');
    expect(screen.getByTestId('settings-api-tokens-revoke-k1')).toBeInTheDocument();
    expect(screen.getByTestId('settings-api-tokens-state-k2')).toHaveTextContent(
      'apiTokens.state.revoked',
    );
    expect(screen.queryByTestId('settings-api-tokens-revoke-k2')).toBeNull();
  });

  test('create shows the plaintext once, until dismissed', async () => {
    mocks.listPersonalTokens.mockReturnValue(okAsync([]));
    mocks.createPersonalToken.mockReturnValue(
      okAsync({ token: 'funny_pat_secret', info: { ...active, id: 'k3', name: 'New' } }),
    );
    renderSettings();

    const create = await screen.findByTestId('settings-api-tokens-create');
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByTestId('settings-api-tokens-name'), {
      target: { value: '  New  ' },
    });
    fireEvent.click(create);

    const shown = await screen.findByTestId('settings-api-tokens-created-value');
    expect(shown).toHaveTextContent('funny_pat_secret');
    expect(screen.getByTestId('settings-api-tokens-created')).toHaveTextContent(
      'apiTokens.shownOnce',
    );
    expect(mocks.createPersonalToken).toHaveBeenCalledWith({ name: 'New', days: 90 });
    expect(screen.getByTestId('settings-api-tokens-item-k3')).toBeInTheDocument();
    expect(screen.getByTestId('settings-api-tokens-name')).toHaveValue('');

    fireEvent.click(screen.getByTestId('settings-api-tokens-dismiss'));
    expect(screen.queryByText('funny_pat_secret')).toBeNull();
  });

  test('revoke asks for confirmation before revoking', async () => {
    mocks.listPersonalTokens.mockReturnValue(okAsync([active]));
    mocks.revokePersonalToken.mockReturnValue(okAsync({ ok: true }));
    renderSettings();

    fireEvent.click(await screen.findByTestId('settings-api-tokens-revoke-k1'));
    expect(mocks.revokePersonalToken).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(mocks.revokePersonalToken).toHaveBeenCalledWith('k1'));
    await waitFor(() => expect(mocks.listPersonalTokens).toHaveBeenCalledTimes(2));
  });
});
