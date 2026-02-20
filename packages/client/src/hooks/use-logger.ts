import { useMemo } from 'react';
import { BrowserLogger } from '@funny/observability/browser';

/** Singleton instance shared across all hook consumers. */
let sharedLogger: BrowserLogger | null = null;

function getSharedLogger(): BrowserLogger {
  if (!sharedLogger) {
    sharedLogger = new BrowserLogger({ endpoint: '/api/logs' });
  }
  return sharedLogger;
}

/**
 * React hook — thin wrapper around BrowserLogger.
 * Returns a namespaced logger that batches and sends logs to POST /api/logs.
 *
 * Usage:
 *   const log = useLogger('MyComponent');
 *   log.info('Button clicked');
 *   log.error('Failed to load', { 'api.url': '/projects' });
 */
export function useLogger(namespace?: string) {
  return useMemo(() => {
    const logger = getSharedLogger();
    if (namespace) {
      return logger.child({ 'log.namespace': namespace });
    }
    return logger;
  }, [namespace]);
}
