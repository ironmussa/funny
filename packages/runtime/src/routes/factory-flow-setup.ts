/**
 * Factory flow setup routes on the runner (openspec factory-flow-bootstrap, D4 / Task 3.5).
 *
 * All endpoints require an owned thread whose `source` is `'factory-setup'`.
 *
 * POST   /api/threads/:id/factory-flow-setup/detect           — detect test stack in the setup worktree
 * POST   /api/threads/:id/factory-flow-setup/verify           — start a rule verification job
 * GET    /api/threads/:id/factory-flow-setup/verify/:jobId    — poll a verification job
 * DELETE /api/threads/:id/factory-flow-setup/verify/:jobId    — cancel a verification job
 * POST   /api/threads/:id/factory-flow-setup/commit           — commit setup files and push to default branch
 * POST   /api/threads/:id/factory-flow-setup/pull-request     — push setup branch and open a pull request
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { detectTestStack } from '@funny/core';
import { Hono, type Context } from 'hono';
import type { z } from 'zod';

import {
  commitAndPushSetup,
  pushSetupBranchAndOpenPR,
} from '../services/factory-flow-setup-git.js';
import {
  cancelFlowSetupVerifyJob,
  getFlowSetupVerifyJob,
  startFlowSetupVerifyJob,
} from '../services/factory-flow-setup-verify.js';
import { canDoGitOps, isWorktreeCheckoutMissing } from '../services/thread-context.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import {
  commitFlowSetupSchema,
  openFlowSetupPRSchema,
  validate,
  verifyFlowSetupSchema,
  type commitFlowSetupAnswerSchema,
  type flowSetupFileAnswerSchema,
  type openFlowSetupPRAnswerSchema,
  type verifyFlowSetupPollAnswerSchema,
  type verifyFlowSetupStartAnswerSchema,
} from '../validation/schemas.js';
import { resolveGithubToken } from './github/helpers.js';
import {
  answerRefusal,
  type OwnedThread,
  projectPathOf,
  withProjectAndBody,
  type Refusal,
  refuse,
  withOwnedThread,
} from './owned-thread.js';

export const factoryFlowSetupRoutes = new Hono<HonoEnv>();

/**
 * Require the caller's own thread AND verify its role (`source`) is `'factory-setup'`.
 */
async function withFactorySetupThread(
  c: Context<HonoEnv>,
  handle: (thread: OwnedThread) => Response | Promise<Response>,
): Promise<Response> {
  return withOwnedThread(c, (thread) =>
    thread.source === 'factory-setup'
      ? handle(thread)
      : answerRefusal(c, refuse(403, 'wrong-thread-role', 'Thread is not a factory setup thread')),
  );
}

function requireSetupWorktree(thread: OwnedThread): Refusal | { worktreePath: string } {
  if (!canDoGitOps(thread)) {
    return refuse(
      400,
      'setup-not-allowed-for-scratch',
      'Factory setup is not available for scratch threads',
    );
  }
  if (isWorktreeCheckoutMissing(thread) || !thread.worktreePath) {
    return refuse(409, 'worktree-missing', 'The setup thread has no worktree checkout');
  }
  return { worktreePath: thread.worktreePath };
}

/** The worktree path of a `.funny/workflows/` file the route may read, or why it may not. */
function setupFilePath(worktreePath: string, relPath: string): Refusal | { fullPath: string } {
  const unsafe =
    !relPath ||
    relPath.startsWith('/') ||
    relPath.includes('..') ||
    relPath.includes('\\') ||
    !relPath.startsWith('.funny/workflows/');
  if (unsafe) return refuse(400, 'invalid-path', 'Only .funny/workflows/ paths may be read');
  const fullPath = resolve(worktreePath, relPath);
  if (!fullPath.startsWith(`${resolve(worktreePath)}/`)) {
    return refuse(400, 'invalid-path', 'Path escapes worktree');
  }
  return { fullPath };
}

/** The setup thread's worktree and the request body as `schema` reads it, then `handle`. */
function withSetupBody<T>(
  c: Context<HonoEnv>,
  schema: z.ZodType<T>,
  handle: (thread: OwnedThread, worktreePath: string, body: T) => Promise<Response>,
): Promise<Response> {
  return withFactorySetupThread(c, async (thread) => {
    const wt = requireSetupWorktree(thread);
    if ('status' in wt) return answerRefusal(c, wt);
    const parsed = validate(schema, await c.req.json().catch(() => ({})));
    if (parsed.isErr()) return resultToResponse(c, parsed);
    return handle(thread, wt.worktreePath, parsed.value);
  });
}

factoryFlowSetupRoutes.post('/:id/factory-flow-setup/detect', (c) =>
  withFactorySetupThread(c, async (thread) => {
    const wt = requireSetupWorktree(thread);
    if ('status' in wt) return answerRefusal(c, wt);

    const facts = await detectTestStack(wt.worktreePath);
    if (facts.isErr()) return resultToResponse(c, facts);
    return c.json(facts.value, 200);
  }),
);

factoryFlowSetupRoutes.get('/:id/factory-flow-setup/file', (c) =>
  withFactorySetupThread(c, async (thread) => {
    const wt = requireSetupWorktree(thread);
    if ('status' in wt) return answerRefusal(c, wt);

    const relPath = (c.req.query('path') ?? '').trim();
    const target = setupFilePath(wt.worktreePath, relPath);
    if ('status' in target) return answerRefusal(c, target);
    const { fullPath } = target;

    try {
      const content = await readFile(fullPath, 'utf8');
      return c.json(
        { path: relPath, content } satisfies z.input<typeof flowSetupFileAnswerSchema>,
        200,
      );
    } catch {
      return c.json({ error: `File not found: ${relPath}`, code: 'file-not-found' }, 404);
    }
  }),
);

factoryFlowSetupRoutes.post('/:id/factory-flow-setup/verify', (c) =>
  withFactorySetupThread(c, async (thread) => {
    const wt = requireSetupWorktree(thread);
    if ('status' in wt) return answerRefusal(c, wt);

    return withProjectAndBody(
      c,
      projectPathOf(thread, c.get('userId'), c.get('organizationId')),
      verifyFlowSetupSchema,
      (projectPath, body) => {
        const job = startFlowSetupVerifyJob(thread.id, projectPath, {
          ...body,
          agentWorktreePath: wt.worktreePath,
        });
        return c.json(
          { jobId: job.id, state: job.state } satisfies z.input<
            typeof verifyFlowSetupStartAnswerSchema
          >,
          200,
        );
      },
    );
  }),
);

factoryFlowSetupRoutes.get('/:id/factory-flow-setup/verify/:jobId', (c) =>
  withFactorySetupThread(c, (thread) => {
    const job = getFlowSetupVerifyJob(thread.id, c.req.param('jobId') ?? '');
    if (!job) {
      return c.json({ error: 'Verification job not found', code: 'verify-job-not-found' }, 404);
    }
    const answer: z.input<typeof verifyFlowSetupPollAnswerSchema> =
      job.state === 'done' && job.result
        ? { state: 'done', result: job.result }
        : { state: 'running' };
    return c.json(answer, 200);
  }),
);

factoryFlowSetupRoutes.delete('/:id/factory-flow-setup/verify/:jobId', (c) =>
  withFactorySetupThread(c, (thread) => {
    const cancelled = cancelFlowSetupVerifyJob(thread.id, c.req.param('jobId') ?? '');
    if (!cancelled) {
      return c.json({ error: 'Verification job not found', code: 'verify-job-not-found' }, 404);
    }
    return c.json({ state: 'cancelled' }, 200);
  }),
);

factoryFlowSetupRoutes.post('/:id/factory-flow-setup/commit', (c) =>
  withSetupBody(c, commitFlowSetupSchema, async (_thread, worktreePath, body) => {
    const result = await commitAndPushSetup({ worktreePath, ...body });
    return c.json(result satisfies z.input<typeof commitFlowSetupAnswerSchema>, 200);
  }),
);

factoryFlowSetupRoutes.post('/:id/factory-flow-setup/pull-request', (c) =>
  withSetupBody(c, openFlowSetupPRSchema, async (thread, worktreePath, body) => {
    const setupBranch = body.setupBranch ?? thread.branch ?? undefined;
    if (!setupBranch) {
      return answerRefusal(c, refuse(409, 'branch-missing', 'Setup thread has no branch'));
    }
    const githubToken =
      body.githubToken ?? (await resolveGithubToken(c.get('userId')))?.token ?? undefined;
    const result = await pushSetupBranchAndOpenPR({
      worktreePath,
      setupBranch,
      defaultBranch: body.defaultBranch,
      title: body.title,
      body: body.body,
      githubToken,
      remote: body.remote,
    });
    return c.json(result satisfies z.input<typeof openFlowSetupPRAnswerSchema>, 200);
  }),
);
