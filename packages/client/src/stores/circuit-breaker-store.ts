import { create } from 'zustand';

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;

const isTauri = !!(window as any).__TAURI_INTERNALS__;
const serverPort = import.meta.env.VITE_SERVER_PORT || '3001';
const HEALTH_URL = isTauri ? `http://localhost:${serverPort}/api/health` : '/api/health';

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerStore {
  state: CircuitState;
  failureCount: number;
  _cooldownTimer: ReturnType<typeof setTimeout> | null;

  recordFailure: () => void;
  recordSuccess: () => void;
  retryNow: () => Promise<void>;
}

export const useCircuitBreakerStore = create<CircuitBreakerStore>((set, get) => ({
  state: 'closed',
  failureCount: 0,
  _cooldownTimer: null,

  recordFailure: () => {
    const { state, failureCount, _cooldownTimer } = get();
    if (state === 'half-open') {
      // Probe failed — go back to open
      set({ state: 'open' });
      startCooldown(get, set);
      return;
    }
    const next = failureCount + 1;
    if (next >= FAILURE_THRESHOLD && state === 'closed') {
      if (_cooldownTimer) clearTimeout(_cooldownTimer);
      set({ state: 'open', failureCount: next, _cooldownTimer: null });
      startCooldown(get, set);
    } else {
      set({ failureCount: next });
    }
  },

  recordSuccess: () => {
    const { _cooldownTimer } = get();
    if (_cooldownTimer) clearTimeout(_cooldownTimer);
    set({ state: 'closed', failureCount: 0, _cooldownTimer: null });
  },

  retryNow: async () => {
    const { _cooldownTimer } = get();
    if (_cooldownTimer) clearTimeout(_cooldownTimer);
    set({ state: 'half-open', _cooldownTimer: null });
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      const res = await fetch(HEALTH_URL, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        get().recordSuccess();
      } else {
        get().recordFailure();
      }
    } catch {
      get().recordFailure();
    }
  },
}));

function startCooldown(
  get: () => CircuitBreakerStore,
  set: (partial: Partial<CircuitBreakerStore>) => void,
) {
  const timer = setTimeout(() => {
    // Auto-probe after cooldown
    get().retryNow();
  }, COOLDOWN_MS);
  set({ _cooldownTimer: timer });
}
