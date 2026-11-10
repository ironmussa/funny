/**
 * POST /api/threads/:id/sandbox/checkout (change thread-sandboxes)
 *
 * Called by the server on a thread's sandbox runner right after it connects:
 * clones the thread's project at its canonical path with the owner's
 * per-operation GitHub credential. Owner only (no steer delegation); the path
 * must be exactly the project's path, so the route cannot write elsewhere.
 */

import { normalize } from 'path';

import { badRequest, forbidden, type DomainError } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err, ok, type Result } from 'neverthrow';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import { checkoutProjectIntoSandbox } from '../services/sandbox-checkout.js';
import * as tm from '../services/thread-manager.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireProject, requireThread } from '../utils/route-helpers.js';
import { validate } from '../validation/schemas.js';
import { resolveGithubToken } from './github/helpers.js';

const checkoutSchema = z
  .object({
    path: z.string().min(1).max(4096),
    repoUrl: z.string().min(1).max(2048),
    branch: z.string().min(1).max(255).optional(),
  })
  .strict();

/**
 * The thread's project, owned by `userId`, whose path is exactly the requested
 * checkout path.
 */
async function checkoutTarget(
  threadId: string,
  userId: string,
  organizationId: string | null,
  path: string,
): Promise<Result<unknown, DomainError>> {
  const thread = await requireThread(threadId, userId);
  if (thread.isErr()) return err(thread.error);
  if (!thread.value.projectId) return err(badRequest('Scratch threads have no repository'));
  const project = await requireProject(thread.value.projectId, userId, organizationId);
  if (project.isErr()) return err(project.error);
  return normalize(path) === normalize(project.value.path)
    ? ok(project.value)
    : err(forbidden('Checkout path must be the project path'));
}

export const sandboxCheckoutRoutes = new Hono<HonoEnv>();

sandboxCheckoutRoutes.post('/:id/sandbox/checkout', async (c) => {
  const userId = c.get('userId') as string;
  const threadId = c.req.param('id');
  const parsed = validate(checkoutSchema, await c.req.json().catch(() => null));
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const target = await checkoutTarget(threadId, userId, c.get('organizationId'), parsed.value.path);
  if (target.isErr()) return resultToResponse(c, target);

  const token = (await resolveGithubToken(userId))?.token ?? null;
  const result = await checkoutProjectIntoSandbox({ ...parsed.value, token });
  if (result.isErr()) {
    log.warn('Sandbox checkout failed', {
      namespace: 'thread-sandboxes',
      threadId,
      error: result.error.message,
    });
    return resultToResponse(c, result);
  }
  // The remote may not have the requested branch: record the one actually
  // checked out, so the thread shows the branch its sandbox works on.
  const { branch } = result.value;
  if (branch && branch !== parsed.value.branch) {
    await tm.updateThread(threadId, { baseBranch: branch });
  }
  return c.json(result.value);
});
