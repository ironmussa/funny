import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useRouteSync } from '@/hooks/use-route-sync';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

const SCRATCH_ID = 'scratch-abc';

function wrapperFor(route: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
  );
}

describe('useRouteSync — activeThread/URL invariant', () => {
  let selectThreadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Real stores; just stub selectThread so we can assert calls without
    // triggering a network fetch.
    selectThreadSpy = vi.fn().mockResolvedValue(undefined);
    useThreadStore.setState({
      activeThread: null,
      selectedThreadId: null,
      threadsById: {},
      threadIdsByProject: {},
      scratchThreadIds: [],
      selectThread: selectThreadSpy as any,
    });
    useProjectStore.setState({ initialized: true } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('re-syncs activeThread when external code clears it while URL is unchanged', async () => {
    renderHook(() => useRouteSync(), { wrapper: wrapperFor(`/scratch/${SCRATCH_ID}`) });

    // Initial mount calls selectThread once for the URL's threadId.
    await waitFor(() => expect(selectThreadSpy).toHaveBeenCalledWith(SCRATCH_ID));
    const initialCalls = selectThreadSpy.mock.calls.length;

    // Simulate selectThread completing — activeThread now matches the URL.
    useThreadStore.setState({
      selectedThreadId: SCRATCH_ID,
      activeThread: { id: SCRATCH_ID, messages: [] } as any,
    });

    // Simulate org-switch / external clear: activeThread + selectedThreadId
    // wiped while the URL stays at /scratch/SCRATCH_ID. Without the invariant
    // guard, the location-only useEffect never re-fires and WS messages get
    // dropped because handleWSMessage sees activeMatch=false.
    useThreadStore.setState({ activeThread: null, selectedThreadId: null });

    // The store subscription must detect the divergence and re-select.
    await waitFor(() => expect(selectThreadSpy.mock.calls.length).toBeGreaterThan(initialCalls));
    const last = selectThreadSpy.mock.calls[selectThreadSpy.mock.calls.length - 1];
    expect(last[0]).toBe(SCRATCH_ID);
  });

  test('does not re-select while selectThread is mid-flight (selectedThreadId set, activeThread null)', async () => {
    renderHook(() => useRouteSync(), { wrapper: wrapperFor(`/scratch/${SCRATCH_ID}`) });

    await waitFor(() => expect(selectThreadSpy).toHaveBeenCalledWith(SCRATCH_ID));
    const initialCalls = selectThreadSpy.mock.calls.length;

    // selectThread's normal in-flight state: selectedThreadId set, activeThread null.
    // The guard must treat this as "loading", not as divergence.
    useThreadStore.setState({ selectedThreadId: SCRATCH_ID, activeThread: null });

    // Give the subscriber a chance to (incorrectly) fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(selectThreadSpy.mock.calls.length).toBe(initialCalls);
  });

  test('does not re-select the PREVIOUS thread after navigating to a new one', async () => {
    // Regression: the deferred invariant check must read the LIVE URL, not the
    // effect closure. Otherwise, right after the user navigates A → B, the
    // pending timer (scheduled while the URL was A) re-selects A — a spurious
    // blink back to the previous thread on every thread switch.
    const { result } = renderHook(
      () => {
        const navigate = useNavigate();
        useRouteSync();
        return navigate;
      },
      { wrapper: wrapperFor('/scratch/A') },
    );

    await waitFor(() => expect(selectThreadSpy).toHaveBeenCalledWith('A'));
    act(() => {
      useThreadStore.setState({
        selectedThreadId: 'A',
        activeThread: { id: 'A', messages: [] } as any,
      });
    });
    selectThreadSpy.mockClear();

    // User navigates to B; then B's selectThread lands its activeThread.
    act(() => result.current('/scratch/B'));
    act(() => {
      useThreadStore.setState({
        selectedThreadId: 'B',
        activeThread: { id: 'B', messages: [] } as any,
      });
    });

    // Wait past the 200ms debounce so the deferred check runs.
    await new Promise((r) => setTimeout(r, 300));

    // The guard must NOT have re-selected the stale previous thread.
    expect(selectThreadSpy).not.toHaveBeenCalledWith('A');
  });

  test('does not re-select when activeThread already matches the URL', async () => {
    useThreadStore.setState({
      selectedThreadId: SCRATCH_ID,
      activeThread: { id: SCRATCH_ID, messages: [] } as any,
    });

    renderHook(() => useRouteSync(), { wrapper: wrapperFor(`/scratch/${SCRATCH_ID}`) });

    // Trigger an unrelated store update that should be ignored.
    useThreadStore.setState({ scratchThreadTotal: 5 });

    await new Promise((r) => setTimeout(r, 50));
    // selectThread should NOT have been called from the invariant guard for
    // the matched state. The initial location-effect may still call it once
    // (because the activeThread match condition is checked there too), so we
    // only assert no extra calls beyond what the initial effect did.
    const calls = selectThreadSpy.mock.calls.filter((c) => c[0] === SCRATCH_ID);
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});
