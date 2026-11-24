/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import type { ErrorHandler } from 'hono';

import { log } from '../lib/logger.js';
import { metric } from '../lib/telemetry.js';

/**
 * Hono global error handler — safety net for unexpected errors.
 *
 * With neverthrow, most errors are handled via Result types in route handlers.
 * This handler only catches truly unexpected errors that bypass Result handling.
 */
export const handleError: ErrorHandler = (err, c) => {
  // SAFETY: `command` / `stderr` are only read after `e?.name === 'ProcessExecutionError'`,
  // which has those fields; they are only logged, so a missing one logs as undefined.
  const e = err as any;

  // ProcessExecutionError — git / CLI command failures that escaped Result handling
  if (e?.name === 'ProcessExecutionError') {
    log.error('Process execution error', {
      namespace: 'error-handler',
      command: e.command,
      stderr: e.stderr,
    });
    metric('errors.total', 1, {
      type: 'sum',
      attributes: { kind: 'process_execution', name: e.name },
    });
    // Return generic message to client — stderr may contain internal paths and system info
    return c.json({ error: 'Command execution failed' }, 400);
  }

  // Any other Error — log full details server-side, return generic message to client
  log.error('Unhandled error', {
    namespace: 'error-handler',
    message: err?.message,
    stack: err?.stack,
    name: err?.name,
  });
  metric('errors.total', 1, {
    type: 'sum',
    attributes: { kind: 'unhandled', name: err?.name ?? 'Error' },
  });
  return c.json({ error: 'Internal server error' }, 500);
};
