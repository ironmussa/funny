import { fireEvent, screen } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const thread = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api', () => ({
  api: { listProjectMembers: () => okAsync({ members: [] }) },
}));
vi.mock('@/lib/api/threads', () => ({
  threadsApi: { listThreadShares: () => okAsync([]) },
}));
vi.mock('@/stores/thread-context', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useThreadSelector: (selector: (t: unknown) => unknown) => selector(thread.current),
}));

import { ShareThreadButton } from '@/components/thread/header/ShareThreadButton';
import { useAuthStore } from '@/stores/auth-store';
import { useUIStore } from '@/stores/ui-store';

import { renderWithProviders } from '../helpers/render';

function open(runtime: string) {
  thread.current = { id: 't-1', userId: 'alice', title: 'Fix login', runtime };
  useAuthStore.setState({ user: { id: 'alice', username: 'alice' } } as never);
  renderWithProviders(<ShareThreadButton threadId="t-1" projectId="p-1" />);
  fireEvent.click(screen.getByTestId('header-share-thread'));
}

describe('ShareThreadButton', () => {
  beforeEach(() => {
    useUIStore.setState({ shareDialogOpen: false } as never);
  });

  test('warns that an editor reaches the repository through a sandbox agent', async () => {
    open('sandbox');
    expect(screen.queryByTestId('share-steer-repository-warning')).toBeNull();
    fireEvent.click(await screen.findByTestId('share-level-steer'));
    expect(screen.getByTestId('share-steer-repository-warning')).toHaveTextContent(
      'without your approval',
    );
  });

  test('no warning for a thread that does not run in a sandbox', async () => {
    open('local');
    fireEvent.click(await screen.findByTestId('share-level-steer'));
    expect(screen.queryByTestId('share-steer-repository-warning')).toBeNull();
  });
});
