/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: RecapGenerator
 *
 * POST /api/threads/:id/recap (openspec `thread-recap`, D1): a short summary of
 * the thread's activity since the owner last read it, generated on this runner
 * by the owner's utility model. Owner only: the server gates it with
 * `requireThreadOwner` (it is not on the steer allow-list), and the runtime
 * answers 404 to anyone else, steer claim or not. Sandbox threads are refused:
 * their runner has no host credentials for the utility model.
 */
import { notFound } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import { metric } from '../lib/telemetry.js';
import { requestSpan } from '../middleware/tracing.js';
import { generateThreadRecap, type RecapError } from '../services/recap-generator.js';
import { runsInSandbox } from '../services/thread-context.js';
import * as tm from '../services/thread-manager.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { parseJsonBody } from '../validation/request.js';

export const recapBodySchema = z.object({
  since: z.iso.datetime({ offset: true }),
  newestMessageId: z.string().min(1).max(128),
  // A BCP 47 tag such as `en` or `pt-BR`; it goes into the system prompt.
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/, 'Invalid language')
    .default('en'),
});

const ERROR_STATUS: Record<RecapError['kind'], 404 | 502 | 503 | 504> = {
  'thread-not-found': 404,
  'utility-model-unavailable': 503,
  timeout: 504,
  'provider-error': 502,
};

export const threadRecapRoutes = new Hono<HonoEnv>();

threadRecapRoutes.post('/:id/recap', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId');

  const thread = await tm.getThread(id);
  // Owner only. A steer sharee's signed claim does not admit them here, and a
  // thread the caller does not own answers as if it did not exist.
  if (!thread || thread.userId !== userId) {
    return resultToResponse(c, err(notFound('Thread not found')));
  }
  if (runsInSandbox({ runtime: thread.runtime })) {
    return c.json(
      {
        error: 'Recaps are not available for sandbox threads',
        code: 'recap-not-available-for-sandbox',
      },
      400,
    );
  }

  const body = await parseJsonBody(c, recapBodySchema);
  if (body.isErr()) return resultToResponse(c, body);

  const span = requestSpan(c, 'thread.recap', { threadId: id });
  const result = await generateThreadRecap({
    threadId: id,
    userId,
    since: body.value.since,
    newestMessageId: body.value.newestMessageId,
    language: body.value.language,
    signal: c.req.raw.signal,
  });
  if (result.isErr()) {
    const { kind } = result.error;
    const message = 'message' in result.error ? result.error.message : kind;
    log.warn('Thread recap failed', { namespace: 'recap', threadId: id, kind, error: message });
    metric('threads.recap.failed', 1, { type: 'sum', attributes: { kind } });
    span.end('error', message);
    return c.json({ error: message, code: kind }, ERROR_STATUS[kind]);
  }
  metric('threads.recap.generated', 1, {
    type: 'sum',
    attributes: { empty: String(result.value.recap === null) },
  });
  span.end('ok');
  return c.json(result.value);
});
