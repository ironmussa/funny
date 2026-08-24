import type { CircuitBreakerState } from '@funny/client-core/stores/circuit-breaker';
import type { StoreApi } from 'zustand/vanilla';

export function installBrowserCircuitConnectivity(
  win: Window,
  store: StoreApi<CircuitBreakerState<ReturnType<typeof setTimeout>>>,
): () => void {
  const handleOffline = (): void => store.getState().recordFailure();
  const handleOnline = (): void => {
    if (store.getState().state !== 'closed') void store.getState().retryNow();
  };
  win.addEventListener('offline', handleOffline);
  win.addEventListener('online', handleOnline);
  return () => {
    win.removeEventListener('offline', handleOffline);
    win.removeEventListener('online', handleOnline);
  };
}
