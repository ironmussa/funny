import { getAuthToken, getAuthMode } from '@/lib/api';
import { BrowserLogger } from '@/lib/browser-logger';

let shared: BrowserLogger | null = null;

function getLogger(): BrowserLogger {
  if (!shared) {
    const token = getAuthToken();
    const mode = getAuthMode();
    shared = new BrowserLogger({
      endpoint: '/api/logs',
      authToken: mode !== 'multi' && token ? token : undefined,
      credentials: mode === 'multi' ? 'include' : 'same-origin',
    });
  }
  return shared;
}

/** Non-React logger factory for Zustand stores and plain modules. */
export function createClientLogger(namespace: string) {
  return getLogger().child({ 'log.namespace': namespace });
}
