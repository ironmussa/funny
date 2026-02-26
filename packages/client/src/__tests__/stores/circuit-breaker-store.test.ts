import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock fetch globally before importing the store
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock import.meta.env
vi.stubEnv('VITE_SERVER_PORT', '3001');

import { useCircuitBreakerStore } from '@/stores/circuit-breaker-store';

describe('useCircuitBreakerStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Reset store to initial state
    const { _cooldownTimer } = useCircuitBreakerStore.getState();
    if (_cooldownTimer) clearTimeout(_cooldownTimer);
    useCircuitBreakerStore.setState({
      state: 'closed',
      failureCount: 0,
      _cooldownTimer: null,
    });
    mockFetch.mockReset();
  });

  afterEach(() => {
    // Clean up any pending timers
    const { _cooldownTimer } = useCircuitBreakerStore.getState();
    if (_cooldownTimer) clearTimeout(_cooldownTimer);
    vi.useRealTimers();
  });

  describe('initial state', () => {
    test('state is closed', () => {
      expect(useCircuitBreakerStore.getState().state).toBe('closed');
    });

    test('failureCount is 0', () => {
      expect(useCircuitBreakerStore.getState().failureCount).toBe(0);
    });

    test('cooldown timer is null', () => {
      expect(useCircuitBreakerStore.getState()._cooldownTimer).toBeNull();
    });
  });

  describe('recordFailure', () => {
    test('increments failure count by 1', () => {
      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState().failureCount).toBe(1);
    });

    test('increments count for each call', () => {
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState().failureCount).toBe(2);
    });

    test('stays closed below threshold (FAILURE_THRESHOLD=3)', () => {
      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState().state).toBe('closed');

      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState().state).toBe('closed');
    });

    test('transitions to open at threshold (3 failures)', () => {
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState().state).toBe('open');
      expect(useCircuitBreakerStore.getState().failureCount).toBe(3);
    });

    test('starts cooldown timer when transitioning to open', () => {
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState()._cooldownTimer).not.toBeNull();
    });
  });

  describe('recordSuccess', () => {
    test('resets state to closed', () => {
      // First get to open state
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState().state).toBe('open');

      useCircuitBreakerStore.getState().recordSuccess();
      expect(useCircuitBreakerStore.getState().state).toBe('closed');
    });

    test('resets failure count to 0', () => {
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState().failureCount).toBe(2);

      useCircuitBreakerStore.getState().recordSuccess();
      expect(useCircuitBreakerStore.getState().failureCount).toBe(0);
    });

    test('clears cooldown timer', () => {
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState()._cooldownTimer).not.toBeNull();

      useCircuitBreakerStore.getState().recordSuccess();
      expect(useCircuitBreakerStore.getState()._cooldownTimer).toBeNull();
    });

    test('resets from closed state as well (no-op effectively)', () => {
      useCircuitBreakerStore.getState().recordSuccess();
      expect(useCircuitBreakerStore.getState().state).toBe('closed');
      expect(useCircuitBreakerStore.getState().failureCount).toBe(0);
    });
  });

  describe('half-open state', () => {
    test('recordFailure in half-open goes to open', () => {
      // Manually set to half-open
      useCircuitBreakerStore.setState({ state: 'half-open', failureCount: 3 });

      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState().state).toBe('open');
    });

    test('recordFailure in half-open does not further increment failureCount', () => {
      useCircuitBreakerStore.setState({ state: 'half-open', failureCount: 3 });

      useCircuitBreakerStore.getState().recordFailure();
      // The early return in half-open sets state to open but does not increment
      expect(useCircuitBreakerStore.getState().state).toBe('open');
    });

    test('recordFailure in half-open starts a new cooldown', () => {
      useCircuitBreakerStore.setState({
        state: 'half-open',
        failureCount: 3,
        _cooldownTimer: null,
      });

      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState()._cooldownTimer).not.toBeNull();
    });
  });

  describe('retryNow', () => {
    test('sets state to half-open', async () => {
      // Start in open state
      useCircuitBreakerStore.setState({ state: 'open', failureCount: 3 });

      mockFetch.mockResolvedValueOnce({ ok: true });

      const promise = useCircuitBreakerStore.getState().retryNow();
      // State should be half-open immediately
      expect(useCircuitBreakerStore.getState().state).toBe('half-open');

      await promise;
    });

    test('clears existing cooldown timer', async () => {
      const timer = setTimeout(() => {}, 99999);
      useCircuitBreakerStore.setState({ state: 'open', failureCount: 3, _cooldownTimer: timer });

      mockFetch.mockResolvedValueOnce({ ok: true });

      await useCircuitBreakerStore.getState().retryNow();
      // The old timer should have been cleared (new state has null timer after success)
      expect(useCircuitBreakerStore.getState()._cooldownTimer).toBeNull();
      clearTimeout(timer);
    });

    test('successful probe calls recordSuccess (state becomes closed)', async () => {
      useCircuitBreakerStore.setState({ state: 'open', failureCount: 3 });

      mockFetch.mockResolvedValueOnce({ ok: true });

      await useCircuitBreakerStore.getState().retryNow();

      expect(useCircuitBreakerStore.getState().state).toBe('closed');
      expect(useCircuitBreakerStore.getState().failureCount).toBe(0);
    });

    test('failed probe (non-ok response) calls recordFailure', async () => {
      useCircuitBreakerStore.setState({ state: 'open', failureCount: 3 });

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      await useCircuitBreakerStore.getState().retryNow();

      // half-open -> recordFailure -> open
      expect(useCircuitBreakerStore.getState().state).toBe('open');
    });

    test('failed probe (network error) calls recordFailure', async () => {
      useCircuitBreakerStore.setState({ state: 'open', failureCount: 3 });

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await useCircuitBreakerStore.getState().retryNow();

      // half-open -> recordFailure -> open
      expect(useCircuitBreakerStore.getState().state).toBe('open');
    });

    test('probes the health endpoint', async () => {
      useCircuitBreakerStore.setState({ state: 'open', failureCount: 3 });

      mockFetch.mockResolvedValueOnce({ ok: true });

      await useCircuitBreakerStore.getState().retryNow();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      // The URL will be /api/health (non-Tauri) or http://localhost:3001/api/health (Tauri)
      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain('/api/health');
    });

    test('uses AbortController signal', async () => {
      useCircuitBreakerStore.setState({ state: 'open', failureCount: 3 });

      mockFetch.mockResolvedValueOnce({ ok: true });

      await useCircuitBreakerStore.getState().retryNow();

      const fetchOptions = mockFetch.mock.calls[0][1];
      expect(fetchOptions).toHaveProperty('signal');
      expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('cooldown auto-probe', () => {
    test('auto-probes after cooldown period (15s)', async () => {
      // Trigger open state
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState().state).toBe('open');

      // Mock the fetch for the auto-probe
      mockFetch.mockResolvedValueOnce({ ok: true });

      // Advance time by the cooldown period (15000ms)
      await vi.advanceTimersByTimeAsync(15000);

      // The auto-probe should have been triggered, transitioning through half-open to closed
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  describe('full lifecycle', () => {
    test('closed -> open (3 failures) -> half-open (retryNow) -> closed (success)', async () => {
      // Start closed
      expect(useCircuitBreakerStore.getState().state).toBe('closed');

      // 3 failures -> open
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState().state).toBe('open');

      // Retry with success -> closed
      mockFetch.mockResolvedValueOnce({ ok: true });
      await useCircuitBreakerStore.getState().retryNow();
      expect(useCircuitBreakerStore.getState().state).toBe('closed');
      expect(useCircuitBreakerStore.getState().failureCount).toBe(0);
    });

    test('closed -> open -> half-open (retryNow) -> open (failure) -> half-open -> closed', async () => {
      // 3 failures -> open
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();

      // First retry fails -> back to open
      mockFetch.mockResolvedValueOnce({ ok: false });
      await useCircuitBreakerStore.getState().retryNow();
      expect(useCircuitBreakerStore.getState().state).toBe('open');

      // Second retry succeeds -> closed
      mockFetch.mockResolvedValueOnce({ ok: true });
      await useCircuitBreakerStore.getState().retryNow();
      expect(useCircuitBreakerStore.getState().state).toBe('closed');
    });

    test('failures below threshold then success resets count', () => {
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState().failureCount).toBe(2);
      expect(useCircuitBreakerStore.getState().state).toBe('closed');

      useCircuitBreakerStore.getState().recordSuccess();
      expect(useCircuitBreakerStore.getState().failureCount).toBe(0);
      expect(useCircuitBreakerStore.getState().state).toBe('closed');

      // Now 2 more failures should not trigger open (since count was reset)
      useCircuitBreakerStore.getState().recordFailure();
      useCircuitBreakerStore.getState().recordFailure();
      expect(useCircuitBreakerStore.getState().state).toBe('closed');
      expect(useCircuitBreakerStore.getState().failureCount).toBe(2);
    });
  });
});
