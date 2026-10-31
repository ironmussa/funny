/**
 * POST /api/threads/:id/sandbox/checkout (change thread-sandboxes)
 *
 * Called by the server on a thread's sandbox runner right after it connects:
 * clones the thread's project at its canonical path with the owner's
 * per-operation GitHub credential. Owner only (no steer delegation); the path
 * must be exactly the project's path, so the route cannot write elsewhere.
 */

import { normalize } from 'path';

import { badRequest, forbidden } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import { checkoutProjectIntoSandbox } from '../services/sandbox-checkout.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireProject, requireThread } from '../utils/route-helpers.js';
import { validate } from '../validation/schemas.js';
import { resolveGithubToken } from './github/helpers.js';

const checkoutSchema = z
  .object({
    path: z.string().min(1).max(4096),
    repoUrl: z.string().min(1).max(2048),
  })
  .strict();

export const sandboxCheckoutRoutes = new Hono<HonoEnv>();

sandboxCheckoutRoutes.post('/:id/sandbox/checkout', async (c) => {
  const userId = c.get('userId') as string;
  const parsed = validate(checkoutSchema, await c.req.json().catch(() => null));
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const thread = await requireThread(c.req.param('id'), userId);
  if (thread.isErr()) return resultToResponse(c, thread);
  if (!thread.value.projectId) {
    return resultToResponse(c, err(badRequest('Scratch threads have no repository')));
  }
  const project = await requireProject(thread.value.projectId, userId, c.get('organizationId'));
  if (project.isErr()) return resultToResponse(c, project);
  if (normalize(parsed.value.path) !== normalize(project.value.path)) {
    return resultToResponse(c, err(forbidden('Checkout path must be the project path')));
  }

  const token = (await resolveGithubToken(userId))?.token ?? null;
  const result = await checkoutProjectIntoSandbox({ ...parsed.value, token });
  if (result.isErr()) {
    log.warn('Sandbox checkout failed', {
      namespace: 'thread-sandboxes',
      threadId: c.req.param('id'),
      error: result.error.message,
    });
    return resultToResponse(c, result);
  }
  return c.json(result.value);
});
