/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import {
  checkWorktreePathInProject,
  createWorktree,
  getStatusSummary,
  listWorktrees,
  previewWorktree,
  worktreeUnsavedWork,
} from '@funny/core/git';
import { badRequest } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { log } from '../lib/logger.js';
import { cleanupWorkspace, pruneOrphans } from '../services/workspace-cleanup.js';
import type { HonoEnv } from '../types/hono-env.js';
import { recordedFailureResponse, resultToResponse } from '../utils/result-response.js';
import { requireProject } from '../utils/route-helpers.js';
import { createWorktreeSchema, deleteWorktreeSchema, validate } from '../validation/schemas.js';

export const worktreeRoutes = new Hono<HonoEnv>();

// GET /api/worktrees/preview?projectId=xxx&branchName=xxx
worktreeRoutes.get('/preview', async (c) => {
  const projectId = c.req.query('projectId');
  const branchName = c.req.query('branchName');
  if (!projectId || !branchName)
    return resultToResponse(c, err(badRequest('projectId and branchName are required')));

  const projectResult = await requireProject(
    projectId,
    c.get('userId'),
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const previewResult = await previewWorktree(projectResult.value.path, branchName);
  return resultToResponse(c, previewResult);
});

// GET /api/worktrees/status?projectId=xxx&worktreePath=xxx
worktreeRoutes.get('/status', async (c) => {
  const projectId = c.req.query('projectId');
  const worktreePath = c.req.query('worktreePath');
  if (!projectId || !worktreePath)
    return resultToResponse(c, err(badRequest('projectId and worktreePath are required')));

  const projectResult = await requireProject(
    projectId,
    c.get('userId'),
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  // Security ME-1: `worktreePath` from the query string is otherwise passed
  // unchecked to `getStatusSummary`, which runs `git status` / `git
  // rev-list` in that cwd. A user could enumerate the dirty-file state of
  // any directory the runner UID can read (other git repos on the host)
  // through this single endpoint. Constrain to the project's worktree
  // base, same as CR-3.
  const containmentErr = checkWorktreePathInProject(projectResult.value.path, worktreePath);
  if (containmentErr) return resultToResponse(c, err(containmentErr));

  const statusResult = await getStatusSummary(worktreePath, undefined, projectResult.value.path);
  return resultToResponse(
    c,
    statusResult.map((s) => ({
      unpushedCommitCount: s.unpushedCommitCount,
      dirtyFileCount: s.dirtyFileCount,
      hasRemoteBranch: s.hasRemoteBranch,
    })),
  );
});

// GET /api/worktrees?projectId=xxx
worktreeRoutes.get('/', async (c) => {
  const projectId = c.req.query('projectId');
  if (!projectId) return resultToResponse(c, err(badRequest('projectId is required')));

  const projectResult = await requireProject(
    projectId,
    c.get('userId'),
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  // Prune orphan worktrees before listing (best-effort, non-blocking on
  // failure); recorded as an activity only when a folder was removed.
  await pruneOrphans({
    userId: c.get('userId'),
    projectId,
    projectPath: projectResult.value.path,
  });

  const worktreesResult = await listWorktrees(projectResult.value.path);
  if (worktreesResult.isErr()) return resultToResponse(c, worktreesResult);
  return c.json(worktreesResult.value);
});

// POST /api/worktrees
worktreeRoutes.post('/', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(createWorktreeSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { projectId, branchName, baseBranch } = parsed.value;

  const projectResult = await requireProject(
    projectId,
    c.get('userId'),
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const wtResult = await createWorktree(projectResult.value.path, branchName, baseBranch);
  if (wtResult.isErr()) return resultToResponse(c, wtResult);
  return c.json({ path: wtResult.value, branch: branchName }, 201);
});

// DELETE /api/worktrees
worktreeRoutes.delete('/', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(deleteWorktreeSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { projectId, worktreePath, branchName, deleteBranch, reason, threadId } = parsed.value;

  const projectResult = await requireProject(
    projectId,
    c.get('userId'),
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  // Stops what runs inside, validates the target, removes, records
  // (services/workspace-cleanup.ts).
  const cleanup = await cleanupWorkspace({
    userId: c.get('userId'),
    projectId,
    projectPath: projectResult.value.path,
    threadId: threadId ?? null,
    worktreePath,
    branch: branchName ?? null,
    deleteBranch,
    reason,
  });
  if (cleanup.isErr()) return recordedFailureResponse(c, cleanup.error);

  return c.json({ ok: true });
});

// POST /api/worktrees/remove-unchanged
//
// Remove a worktree only when nothing would be lost with it: no uncommitted
// file and no commit that no remote has. Otherwise answer `removed: false` with
// the counts and leave it in place. The check and the removal are one request
// on the runner, so a caller cannot delete on a stale reading. Used by the
// issue factory for a run that ended without a commit on its branch.
worktreeRoutes.post('/remove-unchanged', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(deleteWorktreeSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { projectId, worktreePath, branchName, deleteBranch, reason, threadId } = parsed.value;

  const projectResult = await requireProject(
    projectId,
    c.get('userId'),
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  // The path runs `git status` below: keep it inside the project's worktrees.
  const containmentErr = checkWorktreePathInProject(projectResult.value.path, worktreePath);
  if (containmentErr) return resultToResponse(c, err(containmentErr));

  const unsaved = await worktreeUnsavedWork(worktreePath);
  if (unsaved.isErr()) return resultToResponse(c, unsaved);
  if (unsaved.value.dirtyFileCount > 0 || unsaved.value.unpushedCommitCount > 0) {
    log.info('Kept a worktree with unsaved work', {
      namespace: 'worktrees',
      worktreePath,
      ...unsaved.value,
    });
    return c.json({ removed: false, ...unsaved.value });
  }

  // Removal itself goes through the workspace module, like DELETE above.
  const cleanup = await cleanupWorkspace({
    userId: c.get('userId'),
    projectId,
    projectPath: projectResult.value.path,
    threadId: threadId ?? null,
    worktreePath,
    branch: branchName ?? null,
    deleteBranch,
    reason,
  });
  if (cleanup.isErr()) return recordedFailureResponse(c, cleanup.error);
  return c.json({ removed: true });
});
