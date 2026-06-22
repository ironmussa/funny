/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { badRequest, internal } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

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
import { validate, mergeSchema, createPRSchema, workflowSchema } from '../../validation/schemas.js';
import { _gitStatusCache, invalidateGitStatusCache, requireProjectCwd } from './helpers.js';

export const workflowRoutes = new Hono<HonoEnv>();

async function readRequiredTargetBranch(c: {
  req: { json: () => Promise<unknown> };
}): Promise<{ targetBranch: string } | Response> {
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(mergeSchema, raw);
  if (parsed.isErr()) return resultToResponse(c as any, parsed);
  if (!parsed.value.targetBranch) {
    return resultToResponse(c as any, err(badRequest('targetBranch is required')));
  }
  return { targetBranch: parsed.value.targetBranch };
}

// POST /api/git/:threadId/pr
workflowRoutes.post('/:threadId/pr', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(createPRSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const span = requestSpan(c, 'git.create_pr', { threadId });
  const result = await gitServiceCreatePR({
    threadId,
    userId,
    cwd: cwdResult.value,
    title: parsed.value.title,
    body: parsed.value.body,
  });
  if (result.isErr()) {
    span.end('error', result.error.message);
    return resultToResponse(c, result);
  }
  span.end('ok');
  return c.json({ ok: true, url: result.value });
});

// POST /api/git/:threadId/merge
workflowRoutes.post('/:threadId/merge', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const threadResult = await requireThread(threadId, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(mergeSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const span = requestSpan(c, 'git.merge', {
    threadId,
    targetBranch: parsed.value.targetBranch,
  });
  const result = await gitServiceMerge({
    threadId,
    userId,
    targetBranch: parsed.value.targetBranch,
    push: parsed.value.push,
    cleanup: parsed.value.cleanup,
  });
  if (result.isErr()) {
    span.end('error', result.error.message);
    return resultToResponse(c, result);
  }
  await invalidateGitStatusCache(threadId);
  span.end('ok');
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/merge-current-into
workflowRoutes.post('/:threadId/merge-current-into', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const threadResult = await requireThread(threadId, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const target = await readRequiredTargetBranch(c);
  if (target instanceof Response) return target;

  const span = requestSpan(c, 'git.merge_current_into', {
    threadId,
    targetBranch: target.targetBranch,
  });
  const result = await mergeCurrentBranchInto(
    threadId,
    userId,
    cwdResult.value,
    target.targetBranch,
    { projectId: threadResult.value.projectId },
  );
  if (result.isErr()) {
    span.end('error', result.error.message);
    return resultToResponse(c, result);
  }
  await invalidateGitStatusCache(threadId);
  span.end('ok');
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/rebase-current-onto
workflowRoutes.post('/:threadId/rebase-current-onto', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const threadResult = await requireThread(threadId, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const target = await readRequiredTargetBranch(c);
  if (target instanceof Response) return target;

  const span = requestSpan(c, 'git.rebase_current_onto', {
    threadId,
    targetBranch: target.targetBranch,
  });
  const result = await rebaseCurrentBranchOnto(
    threadId,
    userId,
    cwdResult.value,
    target.targetBranch,
    { projectId: threadResult.value.projectId },
  );
  if (result.isErr()) {
    span.end('error', result.error.message);
    return resultToResponse(c, result);
  }
  await invalidateGitStatusCache(threadId);
  span.end('ok');
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/workflow — orchestrate multi-step git workflow
workflowRoutes.post('/:threadId/workflow', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const threadResult = await requireThread(threadId, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
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
workflowRoutes.post('/project/:projectId/workflow', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(workflowSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  // Validate: merge/PR not supported in project mode
  if (['commit-merge', 'merge', 'commit-pr', 'create-pr'].includes(parsed.value.action)) {
    return c.json({ error: `Action "${parsed.value.action}" requires a thread` }, 400);
  }

  // Validate file paths
  const allPaths = [...(parsed.value.filesToStage || []), ...(parsed.value.filesToUnstage || [])];
  if (allPaths.length > 0) {
    const pathCheck = validateFilePaths(cwdResult.value, allPaths);
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
      cwd: cwdResult.value,
      ...parsed.value,
    });
    return c.json({ workflowId }, 202);
  } catch (e: any) {
    return resultToResponse(c, err(internal(e.message)));
  }
});

// POST /api/git/project/:projectId/merge-current-into
workflowRoutes.post('/project/:projectId/merge-current-into', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const target = await readRequiredTargetBranch(c);
  if (target instanceof Response) return target;

  const span = requestSpan(c, 'git.project.merge_current_into', {
    projectId,
    targetBranch: target.targetBranch,
  });
  const result = await mergeCurrentBranchInto(
    projectId,
    userId,
    cwdResult.value,
    target.targetBranch,
    { projectId },
  );
  if (result.isErr()) {
    span.end('error', result.error.message);
    return resultToResponse(c, result);
  }
  _gitStatusCache.delete(projectId);
  span.end('ok');
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/rebase-current-onto
workflowRoutes.post('/project/:projectId/rebase-current-onto', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const target = await readRequiredTargetBranch(c);
  if (target instanceof Response) return target;

  const span = requestSpan(c, 'git.project.rebase_current_onto', {
    projectId,
    targetBranch: target.targetBranch,
  });
  const result = await rebaseCurrentBranchOnto(
    projectId,
    userId,
    cwdResult.value,
    target.targetBranch,
    { projectId },
  );
  if (result.isErr()) {
    span.end('error', result.error.message);
    return resultToResponse(c, result);
  }
  _gitStatusCache.delete(projectId);
  span.end('ok');
  return c.json({ ok: true, output: result.value });
});
