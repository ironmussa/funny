import { fireEvent, render, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connections: [] as Array<{ id: string; provider: string; label: string }>,
  settings: null as null | {
    projectId: string;
    connectionId: string;
    sizeId: string;
    enabledByDefault: boolean;
  },
  save: vi.fn(),
  clear: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@/data/runner/hooks', () => ({
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
vi.mock('@/data/runner/actions', () => ({
  saveProjectSandbox: mocks.save,
  clearProjectSandbox: mocks.clear,
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/stores/auth-store', () => ({
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
  test('renders nothing for a project the user does not own', () => {
    const { container } = render(<ProjectSandboxSetting projectId="p1" ownerId="bob" />);
    expect(container).toBeEmptyDOMElement();
  });

  test('without connections it links to Settings > Sandboxes', () => {
    mocks.connections = [];
    render(<ProjectSandboxSetting projectId="p1" ownerId="alice" />);
    fireEvent.click(screen.getByTestId('settings-project-sandbox-add-connection'));
    expect(mocks.navigate).toHaveBeenCalledWith(expect.stringContaining('/preferences/sandboxes'));
  });

  test('not configured: only the connection picker, set to None', () => {
    render(<ProjectSandboxSetting projectId="p1" ownerId="alice" />);
    expect(screen.getByTestId('settings-project-sandbox-connection')).toHaveTextContent('None');
    expect(screen.queryByTestId('settings-project-sandbox-size')).toBeNull();
    expect(screen.queryByTestId('settings-project-sandbox-default')).toBeNull();
  });

  test('configured: size and default are shown; toggling the default saves it', () => {
    mocks.settings = {
      projectId: 'p1',
      connectionId: 'c1',
      sizeId: 'large',
      enabledByDefault: true,
    };
    render(<ProjectSandboxSetting projectId="p1" ownerId="alice" />);
    // The connection name and its provider, so two same-named connections differ.
    expect(screen.getByTestId('settings-project-sandbox-connection')).toHaveTextContent(
      'funny-laptop · InstaBox',
    );
    expect(screen.getByTestId('settings-project-sandbox-size')).toHaveTextContent('large');

    fireEvent.click(screen.getByTestId('settings-project-sandbox-default'));
    expect(mocks.save).toHaveBeenCalledWith('p1', {
      connectionId: 'c1',
      sizeId: 'large',
      enabledByDefault: false,
    });
  });
});
