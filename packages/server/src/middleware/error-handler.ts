import type { Context, ErrorHandler } from 'hono';

/** Application-specific error with HTTP status code */
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Convenience factories */
export const NotFound = (msg: string) => new AppError(msg, 404);
export const BadRequest = (msg: string) => new AppError(msg, 400);
export const Forbidden = (msg: string) => new AppError(msg, 403);

/** Hono global error handler — use with app.onError() */
export const handleError: ErrorHandler = (err, c) => {
  const e = err as any;

  // AppError — typed HTTP errors (NotFound, BadRequest, Forbidden, etc.)
  if (e?.name === 'AppError' && typeof e.statusCode === 'number') {
    return c.json({ error: e.message }, e.statusCode as any);
  }

  // ProcessExecutionError — git / CLI command failures
  if (e?.name === 'ProcessExecutionError') {
    console.error('[error-handler] Process error:', e.command, e.stderr);
    return c.json({ error: e.message }, 400);
  }

  // Any other Error — surface the real message
  console.error('[error-handler]', err);
  const message = e?.message || 'Internal server error';
  return c.json({ error: message }, 500);
};
