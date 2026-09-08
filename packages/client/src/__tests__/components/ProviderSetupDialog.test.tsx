import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { err, ok } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderSetupDialog } from '@/components/ProviderSetupDialog';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  install: vi.fn(),
  fetch: vi.fn(),
  terminal: vi.fn(),
}));
vi.mock('@/lib/api/system', () => ({
  systemApi: { providerSetupStatus: mocks.status, installProviderTool: mocks.install },
}));
vi.mock('@/stores/runner-providers-store', () => ({
  useRunnerProvidersStore: { getState: () => ({ fetch: mocks.fetch }) },
}));
vi.mock('@/lib/open-terminal-tab', () => ({ openProviderLoginTerminal: mocks.terminal }));
const missing = {
  provider: 'gemini',
  state: 'missing',
  installable: true,
  login: 'gemini',
  auth: 'unknown',
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.status.mockResolvedValue(ok(missing));
});
afterEach(cleanup);

describe('ProviderSetupDialog', () => {
  it('uses the prompt project for status and installation and refreshes providers on success', async () => {
    mocks.install.mockResolvedValue(ok({ ...missing, state: 'installing' }));
    render(
      <ProviderSetupDialog
        provider="gemini"
        label="Gemini"
        projectId="thread-project"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Install on runner' }));
    expect(mocks.status).toHaveBeenCalledWith('gemini', 'thread-project');
    expect(mocks.install).toHaveBeenCalledWith('gemini', 'thread-project');
    mocks.status.mockResolvedValue(ok({ ...missing, state: 'installed' }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith(true));
    expect(screen.queryByRole('button', { name: 'Install on runner' })).toBeNull();
    expect(screen.getByText(/does not support automatic session verification/)).toBeTruthy();
  });

  it('allows retry after a request error', async () => {
    mocks.install.mockResolvedValueOnce(err({ message: 'Runner unavailable' }));
    render(
      <ProviderSetupDialog
        provider="gemini"
        label="Gemini"
        projectId="project"
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Install on runner' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Runner unavailable');
    mocks.install.mockResolvedValue(ok({ ...missing, state: 'installed' }));
    mocks.status.mockResolvedValue(ok({ ...missing, state: 'installed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Install on runner' }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith(true));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rechecks status after a read failure', async () => {
    mocks.status.mockResolvedValueOnce(err({ message: 'Runner offline' }));
    render(<ProviderSetupDialog provider="gemini" label="Gemini" onClose={vi.fn()} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Runner offline');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByRole('button', { name: 'Install on runner' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

it('opens the runner login command in the project terminal', async () => {
  const onClose = vi.fn();
  mocks.status.mockResolvedValue(
    ok({
      ...missing,
      state: 'installed',
      auth: 'required',
      loginCommand: 'runner-login-command',
      loginShell: 'bash',
    }),
  );
  render(<ProviderSetupDialog provider="gemini" label="Gemini" projectId="p1" onClose={onClose} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Gemini' }));
  expect(mocks.terminal).toHaveBeenCalledWith({
    projectId: 'p1',
    command: 'runner-login-command',
    shell: 'bash',
    label: 'Connect Gemini',
  });
  expect(onClose).toHaveBeenCalledOnce();
});

it('shows a verified session without asking for another login', async () => {
  mocks.status.mockResolvedValue(
    ok({ ...missing, state: 'installed', auth: 'connected', loginCommand: 'login' }),
  );
  render(<ProviderSetupDialog provider="gemini" label="Gemini" projectId="p1" onClose={vi.fn()} />);
  await screen.findByText('Connected. You can return to your message.');
  expect(screen.queryByRole('button', { name: 'Connect Gemini' })).toBeNull();
});

it('guides Pi installation and opens its login terminal after installation', async () => {
  mocks.status.mockResolvedValue(
    ok({ ...missing, provider: 'pi', state: 'bundled', auth: 'required' }),
  );
  mocks.install.mockResolvedValue(
    ok({ ...missing, provider: 'pi', state: 'installed', auth: 'required' }),
  );
  render(<ProviderSetupDialog provider="pi" label="Pi" projectId="p1" onClose={vi.fn()} />);
  await screen.findByText(/Install Pi to sign in/);
  mocks.status.mockResolvedValue(
    ok({
      ...missing,
      provider: 'pi',
      state: 'installed',
      auth: 'required',
      loginCommand: 'pi-login',
      loginShell: 'bash',
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Install on runner' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Pi' }));
  expect(mocks.install).toHaveBeenCalledWith('pi', 'p1');
  expect(mocks.terminal).toHaveBeenCalledWith({
    projectId: 'p1',
    command: 'pi-login',
    shell: 'bash',
    label: 'Connect Pi',
  });
});
