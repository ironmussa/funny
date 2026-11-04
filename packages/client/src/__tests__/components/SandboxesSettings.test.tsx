import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listSandboxProviders: vi.fn(),
  addInfraConnection: vi.fn(),
  testInfraConnection: vi.fn(),
  deleteInfraConnection: vi.fn(),
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
  },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/data/runner/hooks', () => ({ useSandboxConnections: () => mocks.storeState }));
vi.mock('@/data/runner/queries', () => ({ refreshSandboxConnections: mocks.fetch }));

import { SandboxesSettings } from '@/components/settings/SandboxesSettings';

const provider = { id: 'boat', displayName: 'Boat', capabilities: { sizes: [] } };

describe('SandboxesSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeState.connections = [];
    mocks.storeState.loading = false;
    mocks.fetch.mockResolvedValue(undefined);
    mocks.listSandboxProviders.mockReturnValue(okAsync({ providers: [provider] }));
  });

  test('shows the empty state when there are no connections', () => {
    render(<SandboxesSettings />);
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
