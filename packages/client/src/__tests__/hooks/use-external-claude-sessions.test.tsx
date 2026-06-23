import { act, renderHook } from '@testing-library/react';
import { okAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  resetExternalClaudeSessionsForTests,
  useExternalClaudeSessionsLoaded,
  useExternalClaudeSessionsSync,
} from '@/hooks/use-external-claude-sessions';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    listExternalClaudeSessions: vi.fn(),
  },
}));

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('external Claude sessions sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetExternalClaudeSessionsForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetExternalClaudeSessionsForTests();
  });

  test('polls all projects with a single global request (no projectId)', async () => {
    vi.mocked(api.listExternalClaudeSessions).mockReturnValue(okAsync({ sessions: [] }));

    const { unmount } = renderHook(() => useExternalClaudeSessionsSync());
    await flushMicrotasks();

    expect(api.listExternalClaudeSessions).toHaveBeenCalledTimes(1);
    expect(api.listExternalClaudeSessions).toHaveBeenLastCalledWith({
      projectId: undefined,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await flushMicrotasks();

    // The interval re-polls globally — never per project.
    expect(api.listExternalClaudeSessions).toHaveBeenCalledTimes(2);
    expect(api.listExternalClaudeSessions).toHaveBeenLastCalledWith({
      projectId: undefined,
    });

    unmount();
  });

  test('multiple consumers share one request — no per-project fan-out', async () => {
    vi.mocked(api.listExternalClaudeSessions).mockReturnValue(okAsync({ sessions: [] }));

    // Even if several components mount the syncer, the inflight/hasLoaded
    // dedupe keeps it to a single network request.
    const a = renderHook(() => useExternalClaudeSessionsSync());
    const b = renderHook(() => useExternalClaudeSessionsSync());
    const c = renderHook(() => useExternalClaudeSessionsSync());
    await flushMicrotasks();

    expect(api.listExternalClaudeSessions).toHaveBeenCalledTimes(1);

    a.unmount();
    b.unmount();
    c.unmount();
  });

  test('useExternalClaudeSessionsLoaded flips to true after the global sync', async () => {
    vi.mocked(api.listExternalClaudeSessions).mockReturnValue(okAsync({ sessions: [] }));

    const loaded = renderHook(() => useExternalClaudeSessionsLoaded());
    expect(loaded.result.current).toBe(false);

    const sync = renderHook(() => useExternalClaudeSessionsSync());
    await flushMicrotasks();

    expect(loaded.result.current).toBe(true);

    loaded.unmount();
    sync.unmount();
  });
});
