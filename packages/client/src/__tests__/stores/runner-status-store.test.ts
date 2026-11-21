/**
 * Tests for the runner-status store — the client-side mirror of the
 * server's `runner:status` readiness channel.
 *
 * Regression context: the store is what gates `pty:list` emission in
 * `use-ws.ts`. If the store ever reports `online` when the runner is
 * actually offline (or stays `unknown` after a real `online` event),
 * the terminal panel either freezes on "starting terminal" or fires
 * a `pty:list` RPC that comes back `no-runner` and strands the tabs —
 * exactly the failure mode we just fixed.
 */

import { describe, test, expect, beforeEach, vi, mock } from 'bun:test';

mock.module('@/lib/client-logger', () => ({
  createClientLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { useRunnerStatusStore } from '@/stores/runner-status-store';

describe('useRunnerStatusStore', () => {
  beforeEach(() => {
    useRunnerStatusStore.getState().reset();
  });

  test('initial status is unknown', () => {
    expect(useRunnerStatusStore.getState().status).toBe('unknown');
  });

  test('setStatus("online") transitions from unknown', () => {
    useRunnerStatusStore.getState().setStatus('online');
    expect(useRunnerStatusStore.getState().status).toBe('online');
  });

  test('setStatus toggles between online and offline', () => {
    const { setStatus } = useRunnerStatusStore.getState();
    setStatus('online');
    setStatus('offline');
    expect(useRunnerStatusStore.getState().status).toBe('offline');
    setStatus('online');
    expect(useRunnerStatusStore.getState().status).toBe('online');
  });

  test('setStatus is a no-op when value is unchanged', () => {
    // The no-op short-circuit prevents redundant Zustand subscribers from
    // re-firing — callers (`use-ws.ts`) re-issue `pty:list` on every
    // `online` transition, so a chatty store would multiply RPC traffic.
    useRunnerStatusStore.getState().setStatus('online');
    let updates = 0;
    const unsub = useRunnerStatusStore.subscribe(() => {
      updates += 1;
    });
    useRunnerStatusStore.getState().setStatus('online');
    useRunnerStatusStore.getState().setStatus('online');
    unsub();
    expect(updates).toBe(0);
  });

  test('reset returns to unknown', () => {
    // `reset` runs on socket disconnect; without it a stale `online` would
    // persist across reconnects and cause `use-ws.ts` to skip emitting
    // `pty:list` on the new socket (it gates on the *transition* to online).
    useRunnerStatusStore.getState().setStatus('online');
    useRunnerStatusStore.getState().reset();
    expect(useRunnerStatusStore.getState().status).toBe('unknown');
  });

  test('reset → setStatus("online") fires a subscriber update', () => {
    useRunnerStatusStore.getState().setStatus('online');
    useRunnerStatusStore.getState().reset();
    let observed: string | null = null;
    const unsub = useRunnerStatusStore.subscribe((s) => {
      observed = s.status;
    });
    useRunnerStatusStore.getState().setStatus('online');
    unsub();
    expect<unknown>(observed).toBe('online');
  });
});
