/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import {
  stageFiles,
  unstageFiles,
  stagePatch,
  unstagePatch,
  revertFiles,
  resolveFileConflict,
  resetSoft,
} from '@funny/core/git';
import { Hono } from 'hono';

import {
  stage as gitServiceStage,
  unstage as gitServiceUnstage,
  revert as gitServiceRevert,
  softReset as gitServiceSoftReset,
  checkoutHash as gitServiceCheckoutHash,
  revertCommit as gitServiceRevertCommit,
  resetHard as gitServiceResetHard,
  validateFilePaths,
} from '../../services/git-service.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireThreadCwd } from '../../utils/route-helpers.js';
import {
  validate,
  stageFilesSchema,
  stagePatchSchema,
  resolveConflictSchema,
  checkoutHashSchema,
  revertCommitSchema,
  resetHardSchema,
} from '../../validation/schemas.js';
import { _gitStatusCache, invalidateGitStatusCache, requireProjectCwd } from './helpers.js';

export const stageRoutes = new Hono<HonoEnv>();

// POST /api/git/project/:projectId/stage
stageRoutes.post('/project/:projectId/stage', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const pathCheck = validateFilePaths(cwd, parsed.value.paths);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  const result = await stageFiles(cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true });
});

// POST /api/git/project/:projectId/unstage
stageRoutes.post('/project/:projectId/unstage', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const pathCheck = validateFilePaths(cwd, parsed.value.paths);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  const result = await unstageFiles(cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true });
});

// POST /api/git/project/:projectId/stage-patch — partial (line-level) staging
stageRoutes.post('/project/:projectId/stage-patch', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stagePatchSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const result = await stagePatch(cwd, parsed.value.patch);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true });
});

// POST /api/git/project/:projectId/unstage-patch — partial (line-level) unstaging
stageRoutes.post('/project/:projectId/unstage-patch', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stagePatchSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const result = await unstagePatch(cwd, parsed.value.patch);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true });
});

// POST /api/git/project/:projectId/revert
stageRoutes.post('/project/:projectId/revert', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const pathCheck = validateFilePaths(cwd, parsed.value.paths);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  const result = await revertFiles(cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true });
});

// POST /api/git/project/:projectId/checkout-commit
stageRoutes.post('/project/:projectId/checkout-commit', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  // Security ME-3: `hash` from the request body is passed positionally to
  // `git checkout`. Without a schema, a value like `--force` would be
  // interpreted as a flag. `gitRefSchema` rejects leading-`-` and any char
  // not valid in a git ref / hash.
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(checkoutHashSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await gitServiceCheckoutHash(
    projectId,
    userId,
    cwdResult.value,
    parsed.value.hash,
  );
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/revert-commit
stageRoutes.post('/project/:projectId/revert-commit', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(revertCommitSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await gitServiceRevertCommit(
    projectId,
    userId,
    cwdResult.value,
    parsed.value.hash,
  );
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/reset-hard
stageRoutes.post('/project/:projectId/reset-hard', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(resetHardSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await gitServiceResetHard(projectId, userId, cwdResult.value, parsed.value.hash);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/conflict/resolve
stageRoutes.post('/project/:projectId/conflict/resolve', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(resolveConflictSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const pathCheck = validateFilePaths(cwd, [parsed.value.filePath]);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  const result = await resolveFileConflict(
    cwd,
    parsed.value.filePath,
    parsed.value.blockIndex,
    parsed.value.resolution,
  );
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, remainingConflicts: result.value.remainingConflicts });
});

// POST /api/git/project/:projectId/reset-soft
stageRoutes.post('/project/:projectId/reset-soft', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const result = await resetSoft(cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/stage
stageRoutes.post('/:threadId/stage', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const pathCheck = validateFilePaths(cwd, parsed.value.paths);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);

  const result = await gitServiceStage(threadId, userId, cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);

  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/unstage
stageRoutes.post('/:threadId/unstage', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const pathCheck = validateFilePaths(cwd, parsed.value.paths);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);

  const result = await gitServiceUnstage(threadId, userId, cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);

  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/stage-patch — partial (line-level) staging
stageRoutes.post('/:threadId/stage-patch', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stagePatchSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await stagePatch(cwd, parsed.value.patch);
  if (result.isErr()) return resultToResponse(c, result);

  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/unstage-patch — partial (line-level) unstaging
stageRoutes.post('/:threadId/unstage-patch', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stagePatchSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await unstagePatch(cwd, parsed.value.patch);
  if (result.isErr()) return resultToResponse(c, result);

  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/revert
stageRoutes.post('/:threadId/revert', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const pathCheck = validateFilePaths(cwd, parsed.value.paths);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);

  const result = await gitServiceRevert(threadId, userId, cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);

  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/conflict/resolve
stageRoutes.post('/:threadId/conflict/resolve', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(resolveConflictSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const pathCheck = validateFilePaths(cwd, [parsed.value.filePath]);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);

  const result = await resolveFileConflict(
    cwd,
    parsed.value.filePath,
    parsed.value.blockIndex,
    parsed.value.resolution,
  );
  if (result.isErr()) return resultToResponse(c, result);

  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, remainingConflicts: result.value.remainingConflicts });
});

// POST /api/git/:threadId/reset-soft
stageRoutes.post('/:threadId/reset-soft', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const result = await gitServiceSoftReset(threadId, userId, cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/checkout-commit
stageRoutes.post('/:threadId/checkout-commit', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  // Security ME-3: see project-scoped route above for context.
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(checkoutHashSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await gitServiceCheckoutHash(threadId, userId, cwdResult.value, parsed.value.hash);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/revert-commit
stageRoutes.post('/:threadId/revert-commit', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(revertCommitSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await gitServiceRevertCommit(threadId, userId, cwdResult.value, parsed.value.hash);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/reset-hard
stageRoutes.post('/:threadId/reset-hard', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(resetHardSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await gitServiceResetHard(threadId, userId, cwdResult.value, parsed.value.hash);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});
