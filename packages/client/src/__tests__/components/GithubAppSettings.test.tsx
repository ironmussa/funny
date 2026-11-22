import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';

const mocks = (() => ({
  getGithubAppStatus: vi.fn(),
  getGithubAppAccounts: vi.fn(),
  startGithubAppManifest: vi.fn(),
  disconnectGithubApp: vi.fn(),
}))();

mock.module('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
mock.module('@/lib/api', () => ({ api: mocks }));

import { GithubAppSettings } from '@/components/settings/GithubAppSettings';

describe('GithubAppSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // cmdk scrolls the active item into view; jsdom has no layout.
    Element.prototype.scrollIntoView ??= () => {};
  });

  test('not connected: connects the listed personal account with one click', async () => {
    mocks.getGithubAppStatus.mockReturnValue(okAsync({ configured: false, source: 'none' }));
    mocks.getGithubAppAccounts.mockReturnValue(
      okAsync({
        hasToken: true,
        accounts: [
          { login: 'octo', type: 'user' },
          { login: 'acme', type: 'org' },
        ],
      }),
    );
    mocks.startGithubAppManifest.mockReturnValue(
      okAsync({
        action: 'https://github.com/settings/apps/new?state=s',
        manifest: '{}',
        state: 's',
      }),
    );
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    render(<GithubAppSettings />);

    const connect = await screen.findByTestId('github-app-connect');
    expect(screen.getByTestId('github-app-target')).toHaveTextContent('octo (personal account)');
    expect(screen.queryByTestId('github-app-org')).toBeNull();
    expect(screen.queryByTestId('github-app-token-hint')).toBeNull();
    expect(connect).toBeEnabled();
    fireEvent.click(connect);

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(mocks.startGithubAppManifest).toHaveBeenCalledWith({ target: 'user' });
    const form = document.querySelector('form[action^="https://github.com/settings/apps/new"]');
    expect(form?.querySelector('input[name="manifest"]')).not.toBeNull();
    submit.mockRestore();
  });

  test('the target list is searchable and a typed name that is not listed can be used', async () => {
    mocks.getGithubAppStatus.mockReturnValue(okAsync({ configured: false, source: 'none' }));
    mocks.getGithubAppAccounts.mockReturnValue(
      okAsync({
        hasToken: true,
        accounts: [
          { login: 'octo', type: 'user' },
          { login: 'acme', type: 'org' },
          { login: 'globex', type: 'org' },
        ],
      }),
    );
    mocks.startGithubAppManifest.mockReturnValue(
      okAsync({ action: 'https://github.com/organizations/x/settings/apps/new', manifest: '{}' }),
    );
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
    render(<GithubAppSettings />);

    fireEvent.click(await screen.findByTestId('github-app-target'));
    fireEvent.change(screen.getByTestId('github-app-target-search'), {
      target: { value: 'glo' },
    });
    await waitFor(() => expect(screen.queryByTestId('github-app-target-org-acme')).toBeNull());
    fireEvent.click(screen.getByTestId('github-app-target-org-globex'));
    expect(screen.getByTestId('github-app-target')).toHaveTextContent('globex');

    fireEvent.click(screen.getByTestId('github-app-target'));
    fireEvent.change(screen.getByTestId('github-app-target-search'), {
      target: { value: 'initech' },
    });
    const other = await screen.findByTestId('github-app-target-other');
    expect(other).toHaveTextContent('Use organization “initech”');
    fireEvent.click(other);
    expect(screen.getByTestId('github-app-org')).toHaveValue('initech');

    fireEvent.click(screen.getByTestId('github-app-connect'));
    await waitFor(() =>
      expect(mocks.startGithubAppManifest).toHaveBeenCalledWith({ target: 'org', org: 'initech' }),
    );
    submit.mockRestore();
  });

  test('not connected without a GitHub token: suggests saving one', async () => {
    mocks.getGithubAppStatus.mockReturnValue(okAsync({ configured: false, source: 'none' }));
    mocks.getGithubAppAccounts.mockReturnValue(okAsync({ hasToken: false, accounts: [] }));
    render(<GithubAppSettings />);

    expect(await screen.findByTestId('github-app-token-hint')).toBeInTheDocument();
    expect(screen.getByTestId('github-app-target')).toHaveTextContent('Personal account');
    expect(screen.getByTestId('github-app-connect')).toBeEnabled();
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

  test('an App without checks: write says what the factory needs and links its settings', async () => {
    mocks.getGithubAppStatus.mockReturnValue(
      okAsync({
        configured: true,
        source: 'database',
        appId: '42',
        slug: 'funny-acme',
        settingsUrl: 'https://github.com/settings/apps/funny-acme',
        missingPermissions: ['checks: write'],
      }),
    );
    render(<GithubAppSettings />);

    const notice = await screen.findByTestId('github-app-missing-permissions');
    expect(notice).toHaveTextContent('The App lacks checks: write');
    expect(notice).toHaveTextContent('regression proof check');
    expect(screen.getByTestId('github-app-missing-permissions-settings')).toHaveAttribute(
      'href',
      'https://github.com/settings/apps/funny-acme',
    );
  });

  test('an installation that has not accepted the permissions is named', async () => {
    mocks.getGithubAppStatus.mockReturnValue(
      okAsync({
        configured: true,
        source: 'database',
        appId: '42',
        slug: 'funny-acme',
        missingPermissions: [],
        pendingInstallations: ['acme', 'alice'],
      }),
    );
    render(<GithubAppSettings />);

    const notice = await screen.findByTestId('github-app-pending-installations');
    expect(notice).toHaveTextContent('acme, alice');
    expect(notice).toHaveTextContent('regression proof check');
    expect(screen.queryByTestId('github-app-missing-permissions')).toBeNull();
  });

  test('an App with every permission shows no notice', async () => {
    mocks.getGithubAppStatus.mockReturnValue(
      okAsync({
        configured: true,
        source: 'database',
        appId: '42',
        slug: 'funny-acme',
        missingPermissions: [],
        pendingInstallations: [],
      }),
    );
    render(<GithubAppSettings />);
    await screen.findByTestId('github-app-connected');
    expect(screen.queryByTestId('github-app-missing-permissions')).toBeNull();
    expect(screen.queryByTestId('github-app-pending-installations')).toBeNull();
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
