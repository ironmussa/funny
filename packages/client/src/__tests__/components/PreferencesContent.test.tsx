import { fireEvent, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { installTestDataLayer } from '../helpers/data-layer-harness';
import { mockT } from '../helpers/mock-i18n';
import { renderWithProviders } from '../helpers/render';

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getSmtpSettings: vi.fn(),
  updateProfile: vi.fn(),
  updateSmtpSettings: vi.fn(),
  testSmtpSettings: vi.fn(),
  isAdmin: true,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mockT,
    i18n: { language: 'en', options: { resources: { en: {} } }, changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/lib/api', () => ({
  api: {
    getProfile: mocks.getProfile,
    getSmtpSettings: mocks.getSmtpSettings,
    updateProfile: mocks.updateProfile,
    updateSmtpSettings: mocks.updateSmtpSettings,
    testSmtpSettings: mocks.testSmtpSettings,
  },
}));

// Provider keys come from the profile query, which calls profileApi directly.
vi.mock('@/lib/api/profile', () => ({
  profileApi: { getProfile: mocks.getProfile, updateProfile: mocks.updateProfile },
}));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) =>
    sel({ user: { role: mocks.isAdmin ? 'admin' : 'user' } }),
}));

import { PreferencesContent } from '@/components/general-settings/PreferencesContent';
import { useSettingsStore } from '@/stores/settings-store';

describe('PreferencesContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installTestDataLayer();
    mocks.isAdmin = true;
    mocks.getProfile.mockReturnValue(okAsync({ providerKeys: { github: true } }));
    mocks.getSmtpSettings.mockReturnValue(
      okAsync({
        host: 'smtp.example.com',
        port: '587',
        user: 'me',
        from: 'noreply@example.com',
        hasPassword: false,
        source: 'database',
      }),
    );
    useSettingsStore.setState({ fetchAvailableShells: vi.fn(async () => {}) });
  });

  test('general page renders the editor, shell and notification rows', () => {
    renderWithProviders(<PreferencesContent activePreferencesPage="general" />);
    expect(screen.getByTestId('preferences-editor-select')).toBeInTheDocument();
    expect(screen.getByTestId('preferences-language-select')).toBeInTheDocument();
    expect(screen.getByTestId('preferences-shell-select')).toBeInTheDocument();
    expect(screen.getByTestId('preferences-notifications-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('preferences-notifications-sound-toggle')).toBeInTheDocument();
    expect(useSettingsStore.getState().fetchAvailableShells).toHaveBeenCalled();
  });

  test('appearance page renders every theme card', () => {
    renderWithProviders(<PreferencesContent activePreferencesPage="appearance" />);
    expect(screen.getByTestId('preferences-theme-one-dark')).toBeInTheDocument();
    expect(screen.getByTestId('preferences-theme-monochrome-dark')).toBeInTheDocument();
    expect(screen.getByTestId('preferences-font-size-select')).toBeInTheDocument();
  });

  test('github page shows the clear button once a token is stored', async () => {
    renderWithProviders(<PreferencesContent activePreferencesPage="github" />);
    expect(await screen.findByTestId('preferences-clear-token')).toBeInTheDocument();
    expect(screen.getByTestId('preferences-save-token')).toBeDisabled();
    fireEvent.change(screen.getByTestId('preferences-github-token'), {
      target: { value: 'ghp_x' },
    });
    expect(screen.getByTestId('preferences-save-token')).toBeEnabled();
  });

  test('email page is filled from the stored SMTP settings', async () => {
    renderWithProviders(<PreferencesContent activePreferencesPage="email" />);
    await waitFor(() =>
      expect(screen.getByTestId('preferences-smtp-host')).toHaveValue('smtp.example.com'),
    );
    expect(screen.getByTestId('preferences-smtp-status')).toHaveTextContent('Configured');
  });

  test('admin-only pages are refused for non-admins', () => {
    mocks.isAdmin = false;
    renderWithProviders(<PreferencesContent activePreferencesPage="email" />);
    expect(screen.getByTestId('preferences-admin-only')).toBeInTheDocument();
    expect(screen.queryByTestId('preferences-smtp-host')).not.toBeInTheDocument();
  });
});
