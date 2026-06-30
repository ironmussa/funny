/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: route
 * @domain layer: presentation
 *
 * Runner-side HTTP surface for the pipeline-driven dispatcher. The
 * server's `PipelineDispatchTunnelAdapter` calls these routes via the
 * runner WS tunnel when `SCHEDULER_USE_PIPELINE_DISPATCHER=true`.
 *
 * The runner trusts the server's per-tunnel auth + tenant headers
 * (already enforced by middleware/auth.ts upstream) — these routes only
 * resolve the per-thread cwd from the local thread record and hand off
 * to the runtime singleton dispatcher.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import { getSchedulerPipelineDispatcher } from '../services/scheduler-pipeline-bootstrap.js';
import { getServices } from '../services/service-registry.js';
import * as tm from '../services/thread-manager.js';
import type { HonoEnv } from '../types/hono-env.js';

export const schedulerRuntimeRoutes = new Hono<HonoEnv>();

const NS = 'scheduler-routes';

const dispatchSchema = z.object({
  threadId: z.string().min(1),
  /** Optional override; defaults to thread.initialPrompt or thread.title. */
  prompt: z.string().optional(),
  /** Pipeline name override; defaults to `scheduler-thread`. */
  pipelineName: z.string().optional(),
  /** User-supplied values for the YAML pipeline's declared inputs. */
  inputs: z.record(z.string(), z.unknown()).optional(),
});

// POST /api/scheduler/dispatch
schedulerRuntimeRoutes.post('/dispatch', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const raw = await c.req.json().catch(() => null);
  const parsed = dispatchSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid request body',
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
      400,
    );
  }

  const { threadId, prompt, pipelineName, inputs } = parsed.data;
  const thread = await tm.getThread(threadId);
  if (!thread) return c.json({ error: 'Thread not found' }, 404);
  if (thread.userId && thread.userId !== userId) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Resolve the working directory the same way `sendMessage` does so that
  // worktree threads run in their isolated branch dir.
  let cwd: string;
  if (thread.worktreePath) {
    cwd = thread.worktreePath;
  } else {
    const pathResult = await getServices().projects.resolveProjectPath(thread.projectId, userId);
    if (pathResult.isErr()) {
      return c.json({ error: pathResult.error.message }, 400);
    }
    cwd = pathResult.value;
  }

  const effectivePrompt =
    prompt?.trim() || thread.initialPrompt?.trim() || thread.title?.trim() || 'Continue.';

  const dispatcher = getSchedulerPipelineDispatcher();
  const result = await dispatcher.dispatch({
    threadId,
    projectId: thread.projectId,
    userId,
    cwd,
    prompt: effectivePrompt,
    pipelineName,
    inputs,
  });

  if (!result.ok) {
    log.warn('Scheduler dispatch failed', {
      namespace: NS,
      threadId,
      userId,
      error: result.error.message,
    });
    return c.json({ error: result.error.message }, 502);
  }

  log.info('Scheduler pipeline dispatch started', {
    namespace: NS,
    threadId,
    userId,
    pipelineRunId: result.handle.pipelineRunId,
    pipelineName: pipelineName ?? 'scheduler-thread',
  });

  return c.json({ pipelineRunId: result.handle.pipelineRunId });
});

// POST /api/scheduler/cancel/:pipelineRunId — best-effort abort.
schedulerRuntimeRoutes.post('/cancel/:pipelineRunId', async (c) => {
  const userId = c.get('userId');
  if (!userId) return c.json({ error: 'Unauthenticated' }, 401);

  const pipelineRunId = c.req.param('pipelineRunId');
  const handle = getSchedulerPipelineDispatcher().getActive(pipelineRunId);
  if (!handle) {
    return c.json({ ok: true, found: false });
  }
  handle.abort();
  log.info('Scheduler pipeline cancel requested', {
    namespace: NS,
    pipelineRunId,
    userId,
  });
  return c.json({ ok: true, found: true });
});
