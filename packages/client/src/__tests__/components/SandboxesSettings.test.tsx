import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listSandboxProviders: vi.fn(),
  addInfraConnection: vi.fn(),
  testInfraConnection: vi.fn(),
  deleteInfraConnection: vi.fn(),
  renameInfraConnection: vi.fn(),
  fetch: vi.fn(),
  storeState: {
    connections: [] as Array<Record<string, unknown>>,
    loading: false,
  },
}));

vi.mock('@/lib/api', () => ({
  api: {
    listSandboxProviders: mocks.listSandboxProviders,
    addInfraConnection: mocks.addInfraConnection,
    testInfraConnection: mocks.testInfraConnection,
    deleteInfraConnection: mocks.deleteInfraConnection,
    renameInfraConnection: mocks.renameInfraConnection,
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/data/runner/hooks', () => ({ useSandboxConnections: () => mocks.storeState }));
vi.mock('@/data/runner/queries', () => ({ refreshSandboxConnections: mocks.fetch }));

import { SandboxesSettings } from '@/components/settings/SandboxesSettings';

import { flushAsyncUpdates } from '../helpers/render';

const provider = { id: 'boat', displayName: 'Boat', capabilities: { sizes: [] } };

describe('SandboxesSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeState.connections = [];
    mocks.storeState.loading = false;
    mocks.fetch.mockResolvedValue(undefined);
    mocks.listSandboxProviders.mockReturnValue(okAsync({ providers: [provider] }));
  });

  test('renames a connection in place: Enter saves, Escape cancels', async () => {
    mocks.storeState.connections = [
      { id: 'c1', provider: 'boat', label: 'funny-laptop', accountLabel: null },
    ];
    mocks.renameInfraConnection.mockReturnValue(okAsync({ id: 'c1', label: 'Personal Boat' }));
    render(<SandboxesSettings />);

    fireEvent.click(screen.getByTestId('sandbox-connection-rename-c1'));
    const input = screen.getByTestId('sandbox-connection-name-c1');
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('sandbox-connection-name-c1')).toBeNull();
    expect(mocks.renameInfraConnection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('sandbox-connection-rename-c1'));
    const again = screen.getByTestId('sandbox-connection-name-c1');
    fireEvent.change(again, { target: { value: '  Personal Boat ' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    await waitFor(() =>
      expect(mocks.renameInfraConnection).toHaveBeenCalledWith('c1', 'Personal Boat'),
    );
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  });

  test('shows the empty state when there are no connections', async () => {
    render(<SandboxesSettings />);
    // The provider list loads on mount.
    await flushAsyncUpdates();
    expect(screen.getByText('No sandbox providers connected yet.')).toBeInTheDocument();
    expect(mocks.fetch).toHaveBeenCalled();
  });

  test('add stays disabled until a provider, name and key are filled', async () => {
    mocks.addInfraConnection.mockReturnValue(
      okAsync({
        id: 'c1',
        provider: 'boat',
        label: 'Personal',
        accountLabel: null,
        createdAt: '',
        lastValidatedAt: null,
      }),
    );
    render(<SandboxesSettings />);

    const add = screen.getByTestId('sandbox-connection-add');
    expect(add).toBeDisabled();

    fireEvent.change(screen.getByTestId('sandbox-connection-label'), {
      target: { value: ' Personal ' },
    });
    fireEvent.change(screen.getByTestId('sandbox-connection-credential'), {
      target: { value: ' key ' },
    });
    // The provider defaults to the first one once the list has loaded.
    await waitFor(() => expect(add).toBeEnabled());

    fireEvent.click(add);
    await waitFor(() =>
      expect(mocks.addInfraConnection).toHaveBeenCalledWith({
        provider: 'boat',
        label: 'Personal',
        credential: 'key',
      }),
    );
    await waitFor(() => expect(screen.getByTestId('sandbox-connection-label')).toHaveValue(''));
  });

  test('lists existing connections with their provider name', async () => {
    mocks.storeState.connections = [
      {
        id: 'c1',
        provider: 'boat',
        label: 'Personal',
        accountLabel: 'me@example.com',
        createdAt: '',
        lastValidatedAt: null,
      },
    ];
    render(<SandboxesSettings />);
    const row = screen.getByTestId('sandbox-connection-c1');
    expect(row).toHaveTextContent('Personal');
    expect(row).toHaveTextContent('me@example.com');
    await waitFor(() => expect(row).toHaveTextContent('Boat'));
  });
});
