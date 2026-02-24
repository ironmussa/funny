/**
 * POST /v1/chat/completions/:id/cancel — Cancel an in-flight chat completion.
 *
 * Aborts the underlying Claude Agent SDK query and closes the stream.
 * Returns 200 if cancelled, 404 if the completion ID is not found
 * (already finished or never existed).
 */

import { Hono } from 'hono';
import * as activeQueries from '../utils/active-queries.js';

export const cancelRoute = new Hono();

cancelRoute.post('/:id/cancel', (c) => {
  const id = c.req.param('id');
  const found = activeQueries.cancel(id);

  if (found) {
    console.log(`[api-acp] cancelled completion ${id}`);
    return c.json({ ok: true, id });
  }

  return c.json(
    { error: { message: `Completion ${id} not found or already finished`, type: 'not_found_error' } },
    404,
  );
});
