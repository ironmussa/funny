import { describe, expect, test } from 'bun:test';

import { createCircuitBreakerStore } from '../stores/circuit-breaker';
import { createClientPreferencesStore, PREFERENCE_KEYS } from '../stores/preferences';
import { createThreadReadStore, THREAD_READ_STORAGE_KEY } from '../stores/thread-read';
import { createInMemoryPlatform } from '../testing/in-memory-platform';

describe('portable client stores', () => {
  test('round-trips thread read markers using the legacy key', () => {
    const host = createInMemoryPlatform({
      storage: { [THREAD_READ_STORAGE_KEY]: JSON.stringify({ old: '2026-01-01T00:00:00Z' }) },
    });
    const store = createThreadReadStore({
      storage: host.platform.storage,
      diagnostics: host.platform.diagnostics,
      now: () => '2026-08-23T00:00:00Z',
    });
    expect(store.getState().readAt.old).toBe('2026-01-01T00:00:00Z');
    store.getState().markRead('new');
    expect(JSON.parse(host.controls.storageSnapshot()[THREAD_READ_STORAGE_KEY])).toEqual({
      old: '2026-01-01T00:00:00Z',
      new: '2026-08-23T00:00:00Z',
    });
    host.controls.setStorage(
      THREAD_READ_STORAGE_KEY,
      JSON.stringify({ remote: '2026-08-24T00:00:00Z' }),
    );
    expect(store.getState().readAt).toEqual({ remote: '2026-08-24T00:00:00Z' });
    store.dispose();
  });

  test('recovers corrupt thread markers and reports diagnostics', () => {
    const host = createInMemoryPlatform({ storage: { [THREAD_READ_STORAGE_KEY]: '[]' } });
    const store = createThreadReadStore({
      storage: host.platform.storage,
      diagnostics: host.platform.diagnostics,
    });
    expect(store.getState().readAt).toEqual({});
    expect(host.controls.storageSnapshot()[THREAD_READ_STORAGE_KEY]).toBeUndefined();
    expect(host.controls.diagnostics).toHaveLength(1);
    store.dispose();
  });

  test('loads and writes portable preferences under existing keys', () => {
    const host = createInMemoryPlatform({
      storage: {
        [PREFERENCE_KEYS.fontSize]: 'large',
        [PREFERENCE_KEYS.hiddenPromptModelsVersion]: '1',
        [PREFERENCE_KEYS.hiddenPromptModels]: JSON.stringify(['claude:opus']),
      },
    });
    const store = createClientPreferencesStore({
      storage: host.platform.storage,
      diagnostics: host.platform.diagnostics,
      defaultHiddenPromptModels: () => ['default:hidden'],
    });
    expect(store.getState()).toMatchObject({
      fontSize: 'large',
      threadViewer: 'virtual',
      hiddenPromptModels: ['claude:opus'],
    });
    store.getState().setNotificationsEnabled(true);
    store.getState().setThreadViewer('frozen');
    expect(host.controls.storageSnapshot()).toMatchObject({
      [PREFERENCE_KEYS.notificationsEnabled]: '1',
      [PREFERENCE_KEYS.threadViewer]: 'frozen',
    });
    host.controls.setStorage(PREFERENCE_KEYS.fontSize, 'small');
    expect(store.getState().fontSize).toBe('small');
    store.dispose();
  });

  test('opens, probes, resets, and disposes the circuit breaker deterministically', async () => {
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    let probeResult = true;
    const store = createCircuitBreakerStore({
      probe: async () => probeResult,
      setTimer(callback) {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
      },
      clearTimer: (timer) => timers.delete(timer as number),
      failureThreshold: 2,
    });
    store.getState().recordFailure();
    store.getState().recordFailure();
    expect(store.getState()).toMatchObject({ state: 'open', failureCount: 2 });
    await store.getState().retryNow();
    expect(store.getState()).toMatchObject({ state: 'closed', failureCount: 0 });
    probeResult = false;
    await store.getState().retryNow();
    expect(store.getState().state).toBe('open');
    store.dispose();
    expect(timers.size).toBe(0);
  });
});
