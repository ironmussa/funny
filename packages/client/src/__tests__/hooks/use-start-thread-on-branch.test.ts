import { describe, expect, test, vi, mock } from 'bun:test';

import { renderHook } from '@testing-library/react';

import { buildPath } from '@/lib/url';
import { useUIStore } from '@/stores/ui-store';

const mockNavigate = vi.fn();
mock.module('@/hooks/use-stable-navigate', () => ({
  useStableNavigate: () => mockNavigate,
}));

const { useStartThreadOnBranch } = await import('@/hooks/use-start-thread-on-branch');

describe('useStartThreadOnBranch', () => {
  test('opens the composer on the branch and navigates to the project route', () => {
    const startNewThread = vi.fn();
    useUIStore.setState({ startNewThread });

    const { result } = renderHook(() => useStartThreadOnBranch());
    result.current('p1', 'feat/x');

    expect(startNewThread).toHaveBeenCalledWith('p1', false, 'feat/x');
    // Without this navigation the route sync re-selects the open thread and
    // the composer never shows.
    expect(mockNavigate).toHaveBeenCalledWith(buildPath('/projects/p1'));
  });
});
