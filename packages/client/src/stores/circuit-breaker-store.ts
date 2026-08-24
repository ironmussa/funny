import {
  createEndpointPolicy,
  createCircuitBreakerStore,
  type CircuitBreakerState,
} from '@funny/client-core';

import { bindVanillaStore } from '@/platform/bind-vanilla-store';
import { clientComposition } from '@/platform/client-composition';
import { installBrowserCircuitConnectivity } from '@/platform/web/circuit-connectivity';

const PROBE_TIMEOUT_MS = 5_000;
const healthUrl = `${createEndpointPolicy(clientComposition.platform.transport.environment).apiBase}/health`;

const circuitBreakerStore = createCircuitBreakerStore<ReturnType<typeof setTimeout>>({
  async probe() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      return (await fetch(healthUrl, { signal: controller.signal })).ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  },
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
});

export const useCircuitBreakerStore =
  bindVanillaStore<CircuitBreakerState<ReturnType<typeof setTimeout>>>(circuitBreakerStore);

const disposeConnectivity = installBrowserCircuitConnectivity(window, circuitBreakerStore);
if (import.meta.hot) import.meta.hot.dispose(disposeConnectivity);
