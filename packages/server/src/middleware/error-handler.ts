import type { ErrorHandler } from 'hono';

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
    console.error('[error-handler] Process error:', e.command, e.stderr);
    return c.json({ error: e.message }, 400);
  }

  // Any other Error — surface the real message
  console.error('[error-handler]', err);
  const message = e?.message || 'Internal server error';
  return c.json({ error: message }, 500);
};
