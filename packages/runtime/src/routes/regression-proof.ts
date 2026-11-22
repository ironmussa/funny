/**
 * Regression proof routes: start and poll a proof job on the thread's runner.
 *
 * POST /api/threads/:id/regression-proof — start a proof (or join a running one)
 * GET  /api/threads/:id/regression-proof/:proofId — poll a proof's state
 * DELETE /api/threads/:id/regression-proof/:proofId — stop a running proof
 *
 * Owner only (no steer delegation). Refuses scratch threads and threads
 * without a checkout.
 */

import { getDefaultBranch, gitRead } from '@funny/core/git';
import { Hono, type Context } from 'hono';
import type { z } from 'zod';

import { cancelProofJob, getProofJob, startProofJob } from '../services/regression-proof.js';
import { canDoGitOps, isWorktreeCheckoutMissing } from '../services/thread-context.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireThread } from '../utils/route-helpers.js';
import { startRegressionProofSchema, validate } from '../validation/schemas.js';

export const regressionProofRoutes = new Hono<HonoEnv>();

type OwnedThread = ReturnType<Awaited<ReturnType<typeof requireThread>>['_unsafeUnwrap']>;
type StartInput = z.output<typeof startRegressionProofSchema>;

/** A refusal the route answers as `{ error, code }`. */
interface Refusal {
  error: string;
  code: string;
  status: 400 | 409;
}

const refuse = (status: Refusal['status'], code: string, error: string): Refusal => ({
  error,
  code,
  status,
});

/** Answer for the caller's own thread, or the 404 / 403 of `requireThread`. */
async function withOwnedThread(
  c: Context<HonoEnv>,
  handle: (thread: OwnedThread) => Response | Promise<Response>,
): Promise<Response> {
  const threadResult = await requireThread(c.req.param('id') ?? '', c.get('userId'));
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  return handle(threadResult.value);
}

/** Why this thread cannot be proved at all, or its project path. */
function provableProject(thread: OwnedThread): Refusal | { projectPath: string } {
  if (!canDoGitOps(thread)) {
    return refuse(
      400,
      'proof-not-allowed-for-scratch',
      'Regression proof is not available for scratch threads',
    );
  }
  if (isWorktreeCheckoutMissing(thread)) {
    return refuse(409, 'worktree-missing', 'The thread has no checkout');
  }
  if (!thread.projectPath) return refuse(400, 'no-project', 'Thread has no project path');
  return { projectPath: thread.projectPath };
}

/**
 * The commit the thread's checkout is on: the run's branch, never the project
 * directory's HEAD when the thread has its own worktree.
 */
async function resolveHead(checkout: string, given?: string): Promise<string | null> {
  if (given) return given;
  const head = await gitRead(['rev-parse', 'HEAD'], { cwd: checkout, reject: false });
  return head.exitCode === 0 && head.stdout.trim() ? head.stdout.trim() : null;
}

async function resolveDefaultBranch(projectPath: string, given?: string): Promise<string | null> {
  if (given) return given;
  const detected = await getDefaultBranch(projectPath);
  return detected.isOk() && detected.value ? detected.value : null;
}

async function startProof(
  thread: OwnedThread,
  projectPath: string,
  input: StartInput,
): Promise<Refusal | { proofId: string; state: string }> {
  const headSha = await resolveHead(thread.worktreePath ?? projectPath, input.headSha);
  if (!headSha) return refuse(409, 'head-unresolved', 'Could not resolve the thread HEAD');
  const defaultBranch = await resolveDefaultBranch(projectPath, input.defaultBranch);
  if (!defaultBranch) {
    return refuse(409, 'default-branch-unresolved', 'Could not resolve the default branch');
  }
  const job = startProofJob(thread.id, projectPath, {
    headSha,
    defaultBranch,
    setupCommand: input.setupCommand,
    rules: input.rules,
    supportGlobs: input.supportGlobs,
    timeoutMs: input.timeoutMs,
  });
  return { proofId: job.id, state: job.state };
}

const answerRefusal = (c: Context<HonoEnv>, refusal: Refusal): Response =>
  c.json({ error: refusal.error, code: refusal.code }, refusal.status);

regressionProofRoutes.post('/:id/regression-proof', (c) =>
  withOwnedThread(c, async (thread) => {
    const project = provableProject(thread);
    if ('status' in project) return answerRefusal(c, project);

    const body = await c.req.json().catch(() => ({}));
    const parsed = validate(startRegressionProofSchema, body);
    if (parsed.isErr()) return resultToResponse(c, parsed);

    const started = await startProof(thread, project.projectPath, parsed.value);
    return 'status' in started ? answerRefusal(c, started) : c.json(started, 200);
  }),
);

regressionProofRoutes.get('/:id/regression-proof/:proofId', (c) =>
  withOwnedThread(c, (thread) => {
    const job = getProofJob(thread.id, c.req.param('proofId') ?? '');
    if (!job) return c.json({ error: 'Proof job not found', code: 'proof-not-found' }, 404);
    if (job.state === 'done') return c.json({ state: 'done', result: job.result }, 200);
    return c.json({ state: 'running' }, 200);
  }),
);

regressionProofRoutes.delete('/:id/regression-proof/:proofId', (c) =>
  withOwnedThread(c, (thread) => {
    const cancelled = cancelProofJob(thread.id, c.req.param('proofId') ?? '');
    if (!cancelled) return c.json({ error: 'Proof job not found', code: 'proof-not-found' }, 404);
    return c.json({ state: 'cancelled' }, 200);
  }),
);
