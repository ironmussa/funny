import type { ErrorHandler } from 'hono';
import { log } from '../lib/abbacchio.js';

/**
 * Hono global error handler — safety net for unexpected errors.
 *
 * With neverthrow, most errors are handled via Result types in route handlers.
 * This handler only catches truly unexpected errors that bypass Result handling.
 */
export const handleError: ErrorHandler = (err, c) => {
  const e = err as any;

  // ProcessExecutionError — git / CLI command failures that escaped Result handling
  if (e?.name === 'ProcessExecutionError') {
    log.error('Process execution error', { namespace: 'error-handler', command: e.command, stderr: e.stderr });
    // Return a generic message; full details logged server-side only
    return c.json({ error: 'Command execution failed' }, 400);
  }

  // Any other Error — log full details server-side, return generic message to client
  log.error('Unhandled error', {
    namespace: 'error-handler',
    message: err?.message,
    stack: err?.stack,
    name: err?.name,
  });
  return c.json({ error: 'Internal server error' }, 500);
};
