/**
 * Pin the commit-history auto-refresh scheduler: debounced bursts, deferral
 * while hidden / busy, and the re-run when history changes mid-refresh.
 * The reload is a controllable promise actor; time uses vitest fake timers.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createActor, fromPromise } from 'xstate';

import {
  HISTORY_REFRESH_DEBOUNCE_MS,
  historyRefreshMachine,
} from '@/machines/history-refresh-machine';

function makeActor(visible = true) {
  const resolvers: Array<() => void> = [];
  const refresh = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)));
  const machine = historyRefreshMachine.provide({
    actors: { refreshHistory: fromPromise(() => refresh()) },
  });
  const actor = createActor(machine, { input: { visible } });
  actor.start();
  const finishRefresh = async () => {
    resolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
  };
  return { actor, refresh, finishRefresh };
}

describe('historyRefreshMachine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('collapses a burst of invalidations into one refresh', async () => {
    const { actor, refresh, finishRefresh } = makeActor();
    actor.send({ type: 'INVALIDATED' });
    await vi.advanceTimersByTimeAsync(HISTORY_REFRESH_DEBOUNCE_MS - 1);
    actor.send({ type: 'INVALIDATED' });
    await vi.advanceTimersByTimeAsync(HISTORY_REFRESH_DEBOUNCE_MS - 1);
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await finishRefresh();
    expect(actor.getSnapshot().value).toBe('fresh');
    actor.stop();
  });

  test('a hidden tab stays stale and refreshes once on reveal', async () => {
    const { actor, refresh } = makeActor(false);
    actor.send({ type: 'INVALIDATED' });
    actor.send({ type: 'INVALIDATED' });
    await vi.advanceTimersByTimeAsync(HISTORY_REFRESH_DEBOUNCE_MS * 4);
    expect(actor.getSnapshot().value).toBe('stale');
    expect(refresh).not.toHaveBeenCalled();

    actor.send({ type: 'VISIBILITY', visible: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  test('waits for an in-flight load to finish before refreshing', async () => {
    const { actor, refresh } = makeActor();
    actor.send({ type: 'BUSY', busy: true });
    actor.send({ type: 'INVALIDATED' });
    await vi.advanceTimersByTimeAsync(HISTORY_REFRESH_DEBOUNCE_MS);
    expect(refresh).not.toHaveBeenCalled();

    actor.send({ type: 'BUSY', busy: false });
    expect(refresh).toHaveBeenCalledTimes(1);
    actor.stop();
  });

  test('a change during a refresh triggers exactly one more refresh', async () => {
    const { actor, refresh, finishRefresh } = makeActor();
    actor.send({ type: 'INVALIDATED' });
    await vi.advanceTimersByTimeAsync(HISTORY_REFRESH_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    actor.send({ type: 'INVALIDATED' });
    actor.send({ type: 'INVALIDATED' });
    await finishRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);
    await finishRefresh();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(actor.getSnapshot().value).toBe('fresh');
    actor.stop();
  });

  test('a failed refresh settles instead of retrying in a loop', async () => {
    const refresh = vi.fn((): Promise<void> => Promise.reject(new Error('boom')));
    const actor = createActor(
      historyRefreshMachine.provide({ actors: { refreshHistory: fromPromise(() => refresh()) } }),
      { input: { visible: true } },
    );
    actor.start();
    actor.send({ type: 'INVALIDATED' });
    await vi.advanceTimersByTimeAsync(HISTORY_REFRESH_DEBOUNCE_MS * 4);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(actor.getSnapshot().value).toBe('fresh');
    actor.stop();
  });

  test('RESET drops a pending refresh (the new context loads itself)', async () => {
    const { actor, refresh } = makeActor(false);
    actor.send({ type: 'INVALIDATED' });
    await vi.advanceTimersByTimeAsync(HISTORY_REFRESH_DEBOUNCE_MS);
    actor.send({ type: 'RESET' });
    actor.send({ type: 'VISIBILITY', visible: true });
    expect(refresh).not.toHaveBeenCalled();
    expect(actor.getSnapshot().value).toBe('fresh');
    actor.stop();
  });
});
