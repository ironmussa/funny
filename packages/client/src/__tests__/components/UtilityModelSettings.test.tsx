import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import type { UserProfile } from '@funny/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';

import { mockT } from '../helpers/mock-i18n';

const updateProfile = vi.fn();
mock.module('@/lib/api/profile', () => ({
  profileApi: { getProfile: vi.fn(), updateProfile, completeSetup: vi.fn() },
}));
mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: mockT, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
mock.module('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
mock.module('@/data/runner/hooks', () => ({ useAcpModels: () => ({}) }));

import { UtilityModelSettings } from '@/components/settings/UtilityModelSettings';
import { profileQuery, writeProfile } from '@/data/profile/queries';
import { getDataLayer } from '@/data/runtime';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: 'p1',
    userId: 'user-1',
    gitName: null,
    gitEmail: null,
    providerKeys: {},
    hasGithubToken: false,
    hasAssemblyaiKey: false,
    hasMinimaxApiKey: false,
    setupCompleted: true,
    defaultEditor: null,
    useInternalEditor: null,
    terminalShell: null,
    toolPermissions: null,
    theme: null,
    runnerInviteToken: null,
    utilityModel: null,
    threadRecapEnabled: true,
    threadRecapMinAbsenceMinutes: 5,
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z',
    ...overrides,
  };
}

const cached = () => getDataLayer().queryClient.getQueryData<UserProfile>(profileQuery().queryKey);

beforeEach(() => {
  updateProfile.mockReset();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('UtilityModelSettings', () => {
  test('the recap switch is on by default and toggling it saves threadRecapEnabled', async () => {
    writeProfile(profile());
    updateProfile.mockReturnValue(okAsync(profile({ threadRecapEnabled: false })));
    render(<UtilityModelSettings />);

    const toggle = screen.getByTestId('settings-thread-recap-toggle');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ threadRecapEnabled: false }));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(cached()?.threadRecapEnabled).toBe(false);
  });

  test('the recap absence shows the saved minutes and is disabled with recaps off', () => {
    writeProfile(profile({ threadRecapMinAbsenceMinutes: 30 }));
    const { unmount } = render(<UtilityModelSettings />);
    const absence = screen.getByTestId('settings-thread-recap-absence');
    expect(absence).toHaveTextContent('30');
    expect(absence).not.toHaveAttribute('data-disabled');
    unmount();

    writeProfile(profile({ threadRecapEnabled: false, threadRecapMinAbsenceMinutes: 30 }));
    render(<UtilityModelSettings />);
    expect(screen.getByTestId('settings-thread-recap-absence')).toHaveAttribute('data-disabled');
  });

  test('default renders Claude Haiku comboboxes and saving effort persists utilityModel', async () => {
    writeProfile(profile());
    const saved = { provider: 'claude' as const, model: 'haiku', effort: 'low' as const };
    updateProfile.mockReturnValue(okAsync(profile({ utilityModel: saved })));
    render(<UtilityModelSettings />);

    expect(screen.getByTestId('settings-utility-model-provider')).toHaveTextContent('Claude');
    expect(screen.getByTestId('settings-utility-model-select')).toBeTruthy();
    expect(screen.queryByTestId('settings-utility-model-name')).toBeNull();
    expect(screen.queryByTestId('settings-utility-model-base-url')).toBeNull();

    fireEvent.click(screen.getByTestId('settings-utility-model-effort-low'));
    fireEvent.click(screen.getByTestId('settings-utility-model-save'));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ utilityModel: saved }));
    await waitFor(() => expect(cached()?.utilityModel).toEqual(saved));
  });

  test('a legacy claude-sdk setting displays as Claude and saves as claude', async () => {
    writeProfile(profile({ utilityModel: { provider: 'claude-sdk', model: 'sonnet' } }));
    const saved = { provider: 'claude' as const, model: 'sonnet', effort: 'high' as const };
    updateProfile.mockReturnValue(okAsync(profile({ utilityModel: saved })));
    render(<UtilityModelSettings />);

    expect(screen.getByTestId('settings-utility-model-provider')).toHaveTextContent('Claude');
    fireEvent.click(screen.getByTestId('settings-utility-model-save'));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ utilityModel: saved }));
  });

  test('an openai-compatible model needs its base URL before it can be saved', async () => {
    writeProfile(
      profile({
        utilityModel: {
          provider: 'openai-compatible',
          model: 'llama',
          baseURL: 'http://localhost:1234/v1',
        },
      }),
    );
    updateProfile.mockReturnValue(okAsync(profile()));
    render(<UtilityModelSettings />);

    expect(screen.getByTestId('settings-utility-model-name')).toHaveValue('llama');
    expect(screen.queryByTestId('settings-utility-model-select')).toBeNull();
    const baseUrl = screen.getByTestId('settings-utility-model-base-url');
    expect(baseUrl).toHaveValue('http://localhost:1234/v1');
    fireEvent.change(baseUrl, { target: { value: '' } });
    expect(screen.getByTestId('settings-utility-model-save')).toBeDisabled();

    fireEvent.click(screen.getByTestId('settings-utility-model-reset'));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ utilityModel: null }));
  });
});
