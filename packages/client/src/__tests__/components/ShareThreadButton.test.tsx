import { beforeEach, describe, expect, test, vi } from 'bun:test';

import type { Thread, ThreadRuntime } from '@funny/shared';
import { fireEvent, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';

interface ThreadRef {
  current: Partial<Thread>;
}

const thread = ((): ThreadRef => ({ current: {} }))();

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', () => ({
  api: { listProjectMembers: () => okAsync({ members: [] }) },
}));
vi.mock('@/lib/api/threads', () => ({
  threadsApi: { listThreadShares: () => okAsync([]) },
}));
const actualStoresThreadContext = { ...(await import('@/stores/thread-context')) };
vi.mock('@/stores/thread-context', () => ({
  ...actualStoresThreadContext,
  useThreadSelector: (selector: (t: unknown) => unknown) => selector(thread.current),
}));

const { ShareThreadButton } = await import('@/components/thread/header/ShareThreadButton');
const { useAuthStore } = await import('@/stores/auth-store');
const { useUIStore } = await import('@/stores/ui-store');

import { renderWithProviders } from '../helpers/render';

function open(runtime: ThreadRuntime, extra: Partial<Thread> = { projectId: 'p-1' }) {
  thread.current = { id: 't-1', userId: 'alice', title: 'Fix login', runtime, ...extra };
  useAuthStore.setState({
    user: { id: 'alice', username: 'alice', displayName: 'alice', role: 'user' },
  });
  renderWithProviders(<ShareThreadButton threadId="t-1" projectId="p-1" />);
  fireEvent.click(screen.getByTestId('header-share-thread'));
}

describe('ShareThreadButton', () => {
  beforeEach(() => {
    useUIStore.setState({ shareDialogOpen: false });
  });

  test('warns that an editor reaches the repository through a sandbox agent', async () => {
    open('sandbox');
    expect(screen.queryByTestId('share-steer-repository-warning')).toBeNull();
    fireEvent.click(await screen.findByTestId('share-level-steer'));
    expect(screen.getByTestId('share-steer-repository-warning')).toHaveTextContent(
      'without your approval',
    );
  });

  test('warns, only at the editor level, that an editor reaches the project secrets', async () => {
    open('local');
    expect(screen.queryByTestId('share-steer-secrets-warning')).toBeNull();
    fireEvent.click(await screen.findByTestId('share-level-comment'));
    expect(screen.queryByTestId('share-steer-secrets-warning')).toBeNull();
    fireEvent.click(screen.getByTestId('share-level-steer'));
    expect(screen.getByTestId('share-steer-secrets-warning')).toHaveTextContent(
      "project's secrets",
    );
  });

  test('no secrets warning for a scratch thread', async () => {
    open('local', { isScratch: true, projectId: '' });
    fireEvent.click(await screen.findByTestId('share-level-steer'));
    expect(screen.queryByTestId('share-steer-secrets-warning')).toBeNull();
  });

  test('no warning for a thread that does not run in a sandbox', async () => {
    open('local');
    fireEvent.click(await screen.findByTestId('share-level-steer'));
    expect(screen.queryByTestId('share-steer-repository-warning')).toBeNull();
  });
});
