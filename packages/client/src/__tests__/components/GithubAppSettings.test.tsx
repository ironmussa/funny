import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getGithubAppStatus: vi.fn(),
  startGithubAppManifest: vi.fn(),
  disconnectGithubApp: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', () => ({ api: mocks }));

import { GithubAppSettings } from '@/components/settings/GithubAppSettings';

describe('GithubAppSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('not connected: offers to connect an organization App', async () => {
    mocks.getGithubAppStatus.mockReturnValue(okAsync({ configured: false, source: 'none' }));
    mocks.startGithubAppManifest.mockReturnValue(
      okAsync({
        action: 'https://github.com/organizations/acme/settings/apps/new?state=s',
        manifest: '{}',
        state: 's',
      }),
    );
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    render(<GithubAppSettings />);

    const connect = await screen.findByTestId('github-app-connect');
    expect(connect).toBeDisabled();
    fireEvent.change(screen.getByTestId('github-app-org'), { target: { value: 'acme' } });
    fireEvent.click(connect);

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(mocks.startGithubAppManifest).toHaveBeenCalledWith({ target: 'org', org: 'acme' });
    const form = document.querySelector('form[action^="https://github.com/organizations/acme"]');
    expect(form?.querySelector('input[name="manifest"]')).not.toBeNull();
    submit.mockRestore();
  });

  test('connected from the database: install link and Disconnect', async () => {
    mocks.getGithubAppStatus.mockReturnValue(
      okAsync({
        configured: true,
        source: 'database',
        appId: '42',
        slug: 'funny-acme',
        owner: 'acme',
        installUrl: 'https://github.com/apps/funny-acme/installations/new',
      }),
    );
    mocks.disconnectGithubApp.mockReturnValue(okAsync({ ok: true }));
    render(<GithubAppSettings />);

    expect(await screen.findByTestId('github-app-install')).toHaveAttribute(
      'href',
      'https://github.com/apps/funny-acme/installations/new',
    );
    fireEvent.click(screen.getByTestId('github-app-disconnect'));
    await waitFor(() => expect(mocks.disconnectGithubApp).toHaveBeenCalled());
  });

  test('configured through server variables: no Connect and no Disconnect', async () => {
    mocks.getGithubAppStatus.mockReturnValue(
      okAsync({
        configured: true,
        source: 'environment',
        appId: '5690396',
        slug: null,
        installUrl: null,
      }),
    );
    render(<GithubAppSettings />);

    expect(await screen.findByTestId('github-app-source')).toHaveTextContent('Server variables');
    expect(screen.queryByTestId('github-app-connect')).toBeNull();
    expect(screen.queryByTestId('github-app-disconnect')).toBeNull();
  });
});
