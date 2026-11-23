/**
 * Factory step routes: start and poll a factory step on the thread's runner
 * (openspec factory-integration): a flow's `run_command`, or `integrate`.
 *
 * POST   /api/threads/:id/factory-steps          — start a step (stops a running one)
 * GET    /api/threads/:id/factory-steps/:stepId  — poll its state
 * DELETE /api/threads/:id/factory-steps/:stepId  — stop it
 *
 * Owner only (no steer delegation). Runs in the thread's own checkout: its
 * worktree, or the project directory of a local-mode thread. Refuses scratch
 * threads and threads without a checkout.
 */

import { Hono, type Context } from 'hono';
import { err } from 'neverthrow';

import { cancelFactoryStep, getFactoryStep, startFactoryStep } from '../services/factory-steps.js';
import { canDoGitOps, isWorktreeCheckoutMissing } from '../services/thread-context.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireProject, requireThread } from '../utils/route-helpers.js';
import { startFactoryStepSchema, validate } from '../validation/schemas.js';

export const factoryStepRoutes = new Hono<HonoEnv>();

type OwnedThread = ReturnType<Awaited<ReturnType<typeof requireThread>>['_unsafeUnwrap']>;

async function withOwnedThread(
  c: Context<HonoEnv>,
  handle: (thread: OwnedThread) => Response | Promise<Response>,
): Promise<Response> {
  const threadResult = await requireThread(c.req.param('id') ?? '', c.get('userId'));
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  return handle(threadResult.value);
}

factoryStepRoutes.post('/:id/factory-steps', (c) =>
  withOwnedThread(c, async (thread) => {
    if (!canDoGitOps(thread)) {
      return c.json(
        { error: 'Factory steps need a checkout', code: 'step-not-allowed-for-scratch' },
        400,
      );
    }
    if (isWorktreeCheckoutMissing(thread)) {
      return c.json({ error: 'The thread has no checkout', code: 'worktree-missing' }, 409);
    }
    if (!thread.projectId)
      return c.json({ error: 'Thread has no project', code: 'no-project' }, 400);
    const project = await requireProject(
      thread.projectId,
      c.get('userId'),
      c.get('organizationId'),
    );
    if (project.isErr()) return resultToResponse(c, err(project.error));
    const cwd = thread.worktreePath ?? project.value.path;
    if (!cwd) return c.json({ error: 'Thread has no checkout path', code: 'no-project' }, 400);

    const body = await c.req.json().catch(() => ({}));
    const parsed = validate(startFactoryStepSchema, body);
    if (parsed.isErr()) return resultToResponse(c, parsed);
    const job = startFactoryStep(thread.id, cwd, parsed.value);
    return c.json({ stepId: job.id, state: job.state }, 200);
  }),
);

factoryStepRoutes.get('/:id/factory-steps/:stepId', (c) =>
  withOwnedThread(c, (thread) => {
    const job = getFactoryStep(thread.id, c.req.param('stepId') ?? '');
    if (!job) return c.json({ error: 'Factory step not found', code: 'step-not-found' }, 404);
    if (job.state === 'done') return c.json({ state: 'done', result: job.result }, 200);
    return c.json({ state: 'running' }, 200);
  }),
);

factoryStepRoutes.delete('/:id/factory-steps/:stepId', (c) =>
  withOwnedThread(c, (thread) => {
    const cancelled = cancelFactoryStep(thread.id, c.req.param('stepId') ?? '');
    if (!cancelled) return c.json({ error: 'Factory step not found', code: 'step-not-found' }, 404);
    return c.json({ state: 'cancelled' }, 200);
  }),
);
