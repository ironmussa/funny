/**
 * Regression proof routes: start and poll a proof job on the thread's runner.
 *
 * POST /api/threads/:id/regression-proof — start a proof (or join a running one)
 * GET  /api/threads/:id/regression-proof/:proofId — poll a proof's state
 *
 * Owner only (no steer delegation). Refuses scratch threads and threads
 * without a checkout.
 */

import { getDefaultBranch, gitRead } from '@funny/core/git';
import { Hono } from 'hono';

import { startProofJob, getProofJob } from '../services/regression-proof.js';
import { canDoGitOps, isWorktreeCheckoutMissing } from '../services/thread-context.js';
import * as tm from '../services/thread-manager.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireThread } from '../utils/route-helpers.js';
import { startRegressionProofSchema, validate } from '../validation/schemas.js';

export const regressionProofRoutes = new Hono<HonoEnv>();

regressionProofRoutes.post('/:id/regression-proof', async (c) => {
  const userId = c.get('userId');
  const threadResult = await requireThread(c.req.param('id'), userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  if (!canDoGitOps(thread)) {
    return c.json(
      {
        error: 'Regression proof is not available for scratch threads',
        code: 'proof-not-allowed-for-scratch',
      },
      400,
    );
  }

  if (isWorktreeCheckoutMissing(thread)) {
    return c.json({ error: 'The thread has no checkout', code: 'worktree-missing' }, 409);
  }

  if (!thread.projectPath) {
    return c.json({ error: 'Thread has no project path', code: 'no-project' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = validate(startRegressionProofSchema, body);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const input = parsed.value;

  // The commit the thread's checkout is on: the run's branch, never the
  // project directory's HEAD when the thread has its own worktree.
  const checkout = thread.worktreePath ?? thread.projectPath;
  let headSha = input.headSha;
  if (!headSha) {
    const head = await gitRead(['rev-parse', 'HEAD'], { cwd: checkout, reject: false });
    if (head.exitCode !== 0 || !head.stdout.trim()) {
      return c.json({ error: 'Could not resolve the thread HEAD', code: 'head-unresolved' }, 409);
    }
    headSha = head.stdout.trim();
  }
  let defaultBranch = input.defaultBranch;
  if (!defaultBranch) {
    const detected = await getDefaultBranch(thread.projectPath);
    defaultBranch = detected.isOk() && detected.value ? detected.value : undefined;
  }
  if (!defaultBranch) {
    return c.json(
      { error: 'Could not resolve the default branch', code: 'default-branch-unresolved' },
      409,
    );
  }

  const job = startProofJob(thread.id, thread.projectPath, thread.worktreePath ?? null, {
    headSha,
    defaultBranch,
    rules: input.rules,
    supportGlobs: input.supportGlobs,
    timeoutMs: input.timeoutMs,
  });

  return c.json({ proofId: job.id, state: job.state }, 200);
});

regressionProofRoutes.get('/:id/regression-proof/:proofId', async (c) => {
  const userId = c.get('userId');
  const threadResult = await requireThread(c.req.param('id'), userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const job = getProofJob(thread.id, c.req.param('proofId'));
  if (!job) {
    return c.json({ error: 'Proof job not found', code: 'proof-not-found' }, 404);
  }

  if (job.state === 'done') {
    return c.json({ state: 'done', result: job.result }, 200);
  }

  return c.json({ state: 'running' }, 200);
});
