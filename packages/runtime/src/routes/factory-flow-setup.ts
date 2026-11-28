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
import type { DomainError } from '@funny/shared/errors';
import { Hono, type Context } from 'hono';
import { err } from 'neverthrow';
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
import { requireProject, requireThread } from '../utils/route-helpers.js';
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

export const factoryFlowSetupRoutes = new Hono<HonoEnv>();

type OwnedThread = ReturnType<Awaited<ReturnType<typeof requireThread>>['_unsafeUnwrap']>;

interface Refusal {
  error: string;
  code: string;
  status: 400 | 403 | 409;
}

const refuse = (status: Refusal['status'], code: string, error: string): Refusal => ({
  error,
  code,
  status,
});

const answerRefusal = (c: Context<HonoEnv>, refusal: Refusal): Response =>
  c.json({ error: refusal.error, code: refusal.code }, refusal.status);

/**
 * Require the caller's own thread AND verify its role (`source`) is `'factory-setup'`.
 */
async function withFactorySetupThread(
  c: Context<HonoEnv>,
  handle: (thread: OwnedThread) => Response | Promise<Response>,
): Promise<Response> {
  const threadResult = await requireThread(c.req.param('id') ?? '', c.get('userId'));
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;
  if (thread.source !== 'factory-setup') {
    return answerRefusal(
      c,
      refuse(403, 'wrong-thread-role', 'Thread is not a factory setup thread'),
    );
  }
  return handle(thread);
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

async function resolveProjectPath(
  thread: OwnedThread,
  userId: string,
  organizationId: string | null | undefined,
): Promise<Refusal | { projectPath: string } | { denied: DomainError }> {
  if (!thread.projectId) return refuse(400, 'no-project', 'Thread has no project');
  const project = await requireProject(thread.projectId, userId, organizationId);
  if (project.isErr()) return { denied: project.error };
  if (!project.value.path) return refuse(400, 'no-project', 'Thread has no project path');
  return { projectPath: project.value.path };
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
    if (
      !relPath ||
      relPath.startsWith('/') ||
      relPath.includes('..') ||
      relPath.includes('\\') ||
      !relPath.startsWith('.funny/workflows/')
    ) {
      return answerRefusal(
        c,
        refuse(400, 'invalid-path', 'Only .funny/workflows/ paths may be read'),
      );
    }

    const fullPath = resolve(wt.worktreePath, relPath);
    const rootPrefix = `${resolve(wt.worktreePath)}/`;
    if (!fullPath.startsWith(rootPrefix)) {
      return answerRefusal(c, refuse(400, 'invalid-path', 'Path escapes worktree'));
    }

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

    const project = await resolveProjectPath(thread, c.get('userId'), c.get('organizationId'));
    if ('denied' in project) return resultToResponse(c, err(project.denied));
    if ('status' in project) return answerRefusal(c, project);

    const body = await c.req.json().catch(() => ({}));
    const parsed = validate(verifyFlowSetupSchema, body);
    if (parsed.isErr()) return resultToResponse(c, parsed);

    const job = startFlowSetupVerifyJob(thread.id, project.projectPath, {
      ...parsed.value,
      agentWorktreePath: wt.worktreePath,
    });
    return c.json(
      { jobId: job.id, state: job.state } satisfies z.input<
        typeof verifyFlowSetupStartAnswerSchema
      >,
      200,
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
  withFactorySetupThread(c, async (thread) => {
    const wt = requireSetupWorktree(thread);
    if ('status' in wt) return answerRefusal(c, wt);

    const body = await c.req.json().catch(() => ({}));
    const parsed = validate(commitFlowSetupSchema, body);
    if (parsed.isErr()) return resultToResponse(c, parsed);

    const result = await commitAndPushSetup({
      worktreePath: wt.worktreePath,
      ...parsed.value,
    });
    return c.json(result satisfies z.input<typeof commitFlowSetupAnswerSchema>, 200);
  }),
);

factoryFlowSetupRoutes.post('/:id/factory-flow-setup/pull-request', (c) =>
  withFactorySetupThread(c, async (thread) => {
    const wt = requireSetupWorktree(thread);
    if ('status' in wt) return answerRefusal(c, wt);

    const body = await c.req.json().catch(() => ({}));
    const parsed = validate(openFlowSetupPRSchema, body);
    if (parsed.isErr()) return resultToResponse(c, parsed);

    const setupBranch = parsed.value.setupBranch ?? thread.branch ?? undefined;
    if (!setupBranch) {
      return answerRefusal(c, refuse(409, 'branch-missing', 'Setup thread has no branch'));
    }

    const githubToken =
      parsed.value.githubToken ?? (await resolveGithubToken(c.get('userId')))?.token ?? undefined;

    const result = await pushSetupBranchAndOpenPR({
      worktreePath: wt.worktreePath,
      setupBranch,
      defaultBranch: parsed.value.defaultBranch,
      title: parsed.value.title,
      body: parsed.value.body,
      githubToken,
      remote: parsed.value.remote,
    });
    return c.json(result satisfies z.input<typeof openFlowSetupPRAnswerSchema>, 200);
  }),
);
