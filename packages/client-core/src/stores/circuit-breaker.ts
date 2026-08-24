import type { PortableStore } from './thread-read';
import { createStore, type StoreApi } from './vanilla-store';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerState<TTimer = unknown> {
  state: CircuitState;
  failureCount: number;
  _cooldownTimer: TTimer | null;
  recordFailure(): void;
  recordSuccess(): void;
  retryNow(): Promise<void>;
}

export interface CircuitBreakerOptions<TTimer> {
  probe(): Promise<boolean>;
  setTimer(callback: () => void, delayMs: number): TTimer;
  clearTimer(timer: TTimer): void;
  failureThreshold?: number;
  cooldownMs?: number;
}

export function createCircuitBreakerStore<TTimer>(
  options: CircuitBreakerOptions<TTimer>,
): PortableStore<CircuitBreakerState<TTimer>> {
  const failureThreshold = options.failureThreshold ?? 3;
  const cooldownMs = options.cooldownMs ?? 15_000;
  let cooldownTimer: TTimer | undefined;
  let disposed = false;

  const clearCooldown = (): void => {
    if (cooldownTimer !== undefined) options.clearTimer(cooldownTimer);
    cooldownTimer = undefined;
    store?.setState({ _cooldownTimer: null });
  };
  let store: StoreApi<CircuitBreakerState<TTimer>> | undefined;
  store = createStore<CircuitBreakerState<TTimer>>((set, get) => {
    const startCooldown = (): void => {
      clearCooldown();
      cooldownTimer = options.setTimer(() => {
        if (!disposed) void get().retryNow();
      }, cooldownMs);
      set({ _cooldownTimer: cooldownTimer });
    };
    return {
      state: 'closed',
      failureCount: 0,
      _cooldownTimer: null,
      recordFailure() {
        const current = get();
        if (current.state === 'half-open') {
          set({ state: 'open' });
          startCooldown();
          return;
        }
        const failureCount = current.failureCount + 1;
        if (failureCount >= failureThreshold && current.state === 'closed') {
          set({ state: 'open', failureCount });
          startCooldown();
        } else set({ failureCount });
      },
      recordSuccess() {
        clearCooldown();
        set({ state: 'closed', failureCount: 0 });
      },
      async retryNow() {
        clearCooldown();
        set({ state: 'half-open' });
        if (await options.probe()) get().recordSuccess();
        else get().recordFailure();
      },
    };
  });

  return Object.assign(store, {
    dispose() {
      disposed = true;
      clearCooldown();
    },
  });
}
