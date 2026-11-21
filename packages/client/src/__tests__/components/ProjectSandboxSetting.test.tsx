import { beforeEach, describe, expect, test, vi, type Mock, mock } from 'bun:test';

import { fireEvent, render, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';

interface SandboxMocks {
  connections: Array<{ id: string; provider: string; label: string }>;
  settings: null | {
    projectId: string;
    connectionId: string;
    sizeId: string;
    mode: 'local' | 'worktree' | 'sandbox';
  };
  save: Mock<(...args: any[]) => any>;
  clear: Mock<(...args: any[]) => any>;
  navigate: Mock<(...args: any[]) => any>;
}

const mocks = ((): SandboxMocks => ({
  connections: [],
  settings: null,
  save: vi.fn(),
  clear: vi.fn(),
  navigate: vi.fn(),
}))();

mock.module('@/data/runner/hooks', () => ({
  useSandboxConnections: () => ({ connections: mocks.connections, loading: false }),
  useSandboxProviders: () => [
    {
      id: 'instabox',
      displayName: 'InstaBox',
      capabilities: {
        sizes: [
          { id: 'default', vcpu: 4, memoryGb: 8, default: true },
          { id: 'large', vcpu: 8, memoryGb: 16 },
        ],
      },
    },
  ],
  useProjectSandbox: () => ({
    loading: false,
    sandbox: mocks.settings ? { settings: mocks.settings, connection: undefined } : null,
  }),
}));
mock.module('@/data/runner/actions', () => ({
  saveProjectSandbox: mocks.save,
  clearProjectSandbox: mocks.clear,
}));
mock.module('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
mock.module('@/stores/auth-store', () => ({
  useAuthStore: (select: (s: { user: { id: string } }) => unknown) =>
    select({ user: { id: 'alice' } }),
}));

import { ProjectSandboxSetting } from '@/components/general-settings-project/ProjectSandboxSetting';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connections = [{ id: 'c1', provider: 'instabox', label: 'funny-laptop' }];
  mocks.settings = null;
  mocks.save.mockReturnValue(okAsync(null));
  mocks.clear.mockReturnValue(okAsync(null));
});

describe('ProjectSandboxSetting', () => {
  test('without connections it links to Settings > Sandboxes', () => {
    mocks.connections = [];
    render(<ProjectSandboxSetting projectId="p1" />);
    fireEvent.click(screen.getByTestId('settings-project-sandbox-add-connection'));
    expect(mocks.navigate).toHaveBeenCalledWith(expect.stringContaining('/preferences/sandboxes'));
  });

  test('not configured: only the connection picker, set to None', () => {
    render(<ProjectSandboxSetting projectId="p1" />);
    expect(screen.getByTestId('settings-project-sandbox-connection')).toHaveTextContent('None');
    expect(screen.queryByTestId('settings-project-sandbox-size')).toBeNull();
  });

  test('choosing a connection starts with the sandbox off, so new threads run locally', async () => {
    // jsdom has no scrollIntoView; the open Radix Select calls it.
    Element.prototype.scrollIntoView = vi.fn();
    render(<ProjectSandboxSetting projectId="p1" />);
    fireEvent.keyDown(screen.getByTestId('settings-project-sandbox-connection'), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: /funny-laptop/ }));
    expect(mocks.save).toHaveBeenCalledWith('p1', { mode: 'local', connectionId: 'c1' });
  });

  test('configured: the connection and size are shown', () => {
    mocks.settings = {
      projectId: 'p1',
      connectionId: 'c1',
      sizeId: 'large',
      mode: 'sandbox',
    };
    render(<ProjectSandboxSetting projectId="p1" />);
    // The connection name and its provider, so two same-named connections differ.
    expect(screen.getByTestId('settings-project-sandbox-connection')).toHaveTextContent(
      'funny-laptop · InstaBox',
    );
    expect(screen.getByTestId('settings-project-sandbox-size')).toHaveTextContent('large');
  });
});
