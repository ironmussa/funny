import { createLogger, type Logger } from '@abbacchio/browser-transport';

const endpoint = import.meta.env.VITE_OTLP_ENDPOINT as string | undefined;

let shared: Logger | null = null;

function getLogger(): Logger {
  if (!shared) {
    shared = createLogger({
      endpoint: endpoint || 'http://localhost:4000',
      serviceName: 'funny-client',
      enabled: !!endpoint,
      includeUrl: true,
    });
  }
  return shared;
}

/** Non-React logger factory for Zustand stores and plain modules. */
export function createClientLogger(namespace: string) {
  return getLogger().child({ 'log.namespace': namespace });
}
