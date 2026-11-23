/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { badRequest, internal, type DomainError } from '@funny/shared/errors';
import { Hono, type Context } from 'hono';
import { err, ok, type Result } from 'neverthrow';

import { requestSpan } from '../../middleware/tracing.js';
import {
  merge as gitServiceMerge,
  createPullRequest as gitServiceCreatePR,
  mergeCurrentBranchInto,
  rebaseCurrentBranchOnto,
  validateFilePaths,
} from '../../services/git-service.js';
import { executeWorkflow, isWorkflowActive } from '../../services/git-workflow-service.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireThread, requireThreadCwd } from '../../utils/route-helpers.js';
import { readBody } from '../../validation/request.js';
import { validate, mergeSchema, createPRSchema, workflowSchema } from '../../validation/schemas.js';
import {
  projectGitMutation,
  threadGitMutation,
  traced,
  withProjectCheckout,
  withThreadCheckout,
} from './checkout-route.js';
import { invalidateGitStatusCache } from './helpers.js';

export const workflowRoutes = new Hono<HonoEnv>();

/** The route's `:threadId` thread, for the caller (no steer sharee). */
async function threadOfRoute(c: Context<HonoEnv>) {
  // SAFETY: only used on routes whose path declares :threadId.
  const threadId = c.req.param('threadId') as string;
  const userId = c.get('userId');
  const thread = await requireThread(threadId, userId);
  return thread.map((row) => ({ threadId, userId, thread: row }));
}

type BranchMove = typeof mergeCurrentBranchInto;

/** The checkout whose current branch a merge or rebase moves. */
interface BranchMoveTarget {
  id: string;
  userId: string;
  cwd: string;
  projectId: string;
  ids: { projectId: string } | { threadId: string };
}

function requireTargetBranch(body: { targetBranch?: string }): Result<string, DomainError> {
  return body.targetBranch ? ok(body.targetBranch) : err(badRequest('targetBranch is required'));
}

/** Merges the current branch into, or rebases it onto, the body's `targetBranch`. */
async function moveCurrentBranch(
  c: Context<HonoEnv>,
  spanName: string,
  op: BranchMove,
  target: BranchMoveTarget,
  body: { targetBranch?: string },
): Promise<Result<string, DomainError>> {
  const branch = requireTargetBranch(body);
  if (branch.isErr()) return err(branch.error);
  return traced(c, spanName, { ...target.ids, targetBranch: branch.value }, () =>
    op(target.id, target.userId, target.cwd, branch.value, { projectId: target.projectId }),
  );
}

/** A thread checkout as a branch-move target: the thread's project comes from its row. */
async function threadMoveTarget(target: {
  threadId: string;
  userId: string;
  cwd: string;
}): Promise<Result<BranchMoveTarget, DomainError>> {
  const thread = await requireThread(target.threadId, target.userId);
  return thread.map((row) => ({
    id: target.threadId,
    userId: target.userId,
    cwd: target.cwd,
    projectId: row.projectId,
    ids: { threadId: target.threadId },
  }));
}

/** The thread route for a branch move: `op` on the thread's checkout. */
function threadBranchMove(c: Context<HonoEnv>, spanName: string, op: BranchMove) {
  return threadGitMutation(c, {
    body: mergeSchema,
    run: async (target, body) => {
      const moveTarget = await threadMoveTarget(target);
      if (moveTarget.isErr()) return err(moveTarget.error);
      return moveCurrentBranch(c, spanName, op, moveTarget.value, body);
    },
  });
}

/** The project route for a branch move: `op` on the caller's checkout of the project. */
function projectBranchMove(c: Context<HonoEnv>, spanName: string, op: BranchMove) {
  return projectGitMutation(c, {
    body: mergeSchema,
    run: ({ projectId, userId, cwd }, body) =>
      moveCurrentBranch(
        c,
        spanName,
        op,
        { id: projectId, userId, cwd, projectId, ids: { projectId } },
        body,
      ),
  });
}

// POST /api/git/:threadId/pr
workflowRoutes.post('/:threadId/pr', (c) =>
  withThreadCheckout(c, async ({ threadId, userId, cwd }) => {
    const parsed = await readBody(c, createPRSchema);
    if (parsed.isErr()) return resultToResponse(c, parsed);

    const span = requestSpan(c, 'git.create_pr', { threadId });
    const result = await gitServiceCreatePR({
      threadId,
      userId,
      cwd: cwd,
      title: parsed.value.title,
      body: parsed.value.body,
    });
    if (result.isErr()) {
      span.end('error', result.error.message);
      return resultToResponse(c, result);
    }
    span.end('ok');
    return c.json({ ok: true, url: result.value });
  }),
);

// POST /api/git/:threadId/merge
workflowRoutes.post('/:threadId/merge', async (c) => {
  const routeThread = await threadOfRoute(c);
  if (routeThread.isErr()) return resultToResponse(c, routeThread);
  const { threadId, userId } = routeThread.value;

  const parsed = await readBody(c, mergeSchema);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { targetBranch, push, cleanup } = parsed.value;

  const result = await traced(c, 'git.merge', { threadId, targetBranch }, () =>
    gitServiceMerge({ threadId, userId, targetBranch, push, cleanup }),
  );
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/merge-current-into
workflowRoutes.post('/:threadId/merge-current-into', (c) =>
  threadBranchMove(c, 'git.merge_current_into', mergeCurrentBranchInto),
);

// POST /api/git/:threadId/rebase-current-onto
workflowRoutes.post('/:threadId/rebase-current-onto', (c) =>
  threadBranchMove(c, 'git.rebase_current_onto', rebaseCurrentBranchOnto),
);

// POST /api/git/:threadId/workflow — orchestrate multi-step git workflow
workflowRoutes.post('/:threadId/workflow', async (c) => {
  const routeThread = await threadOfRoute(c);
  if (routeThread.isErr()) return resultToResponse(c, routeThread);
  const { threadId, userId, thread } = routeThread.value;

  const cwdResult = await requireThreadCwd(threadId, userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(workflowSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  // Validate file paths
  const allPaths = [...(parsed.value.filesToStage || []), ...(parsed.value.filesToUnstage || [])];
  if (allPaths.length > 0) {
    const pathCheck = validateFilePaths(cwdResult.value, allPaths);
    if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  }

  if (isWorkflowActive(threadId)) {
    return c.json({ error: 'A workflow is already in progress' }, 409);
  }

  try {
    const { workflowId } = executeWorkflow({
      contextId: threadId,
      threadId,
      projectId: thread.projectId,
      userId,
      cwd: cwdResult.value,
      ...parsed.value,
    });
    return c.json({ workflowId }, 202);
  } catch (e: any) {
    return resultToResponse(c, err(internal(e.message)));
  }
});

// POST /api/git/project/:projectId/workflow — project-scoped workflow
workflowRoutes.post('/project/:projectId/workflow', (c) =>
  withProjectCheckout(c, async ({ projectId, userId, cwd }) => {
    const parsed = await readBody(c, workflowSchema);
    if (parsed.isErr()) return resultToResponse(c, parsed);

    // Validate: merge/PR not supported in project mode
    if (['commit-merge', 'merge', 'commit-pr', 'create-pr'].includes(parsed.value.action)) {
      return c.json({ error: `Action "${parsed.value.action}" requires a thread` }, 400);
    }

    // Validate file paths
    const allPaths = [...(parsed.value.filesToStage || []), ...(parsed.value.filesToUnstage || [])];
    if (allPaths.length > 0) {
      const pathCheck = validateFilePaths(cwd, allPaths);
      if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
    }

    if (isWorkflowActive(projectId)) {
      return c.json({ error: 'A workflow is already in progress' }, 409);
    }

    try {
      const { workflowId } = executeWorkflow({
        contextId: projectId,
        projectId,
        userId,
        cwd: cwd,
        ...parsed.value,
      });
      return c.json({ workflowId }, 202);
    } catch (e: any) {
      return resultToResponse(c, err(internal(e.message)));
    }
  }),
);

// POST /api/git/project/:projectId/merge-current-into
workflowRoutes.post('/project/:projectId/merge-current-into', (c) =>
  projectBranchMove(c, 'git.project.merge_current_into', mergeCurrentBranchInto),
);

// POST /api/git/project/:projectId/rebase-current-onto
workflowRoutes.post('/project/:projectId/rebase-current-onto', (c) =>
  projectBranchMove(c, 'git.project.rebase_current_onto', rebaseCurrentBranchOnto),
);
