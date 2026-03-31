/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import {
  createWorktree,
  getStatusSummary,
  listWorktrees,
  previewWorktree,
  removeBranch,
  removeWorktree,
} from '@funny/core/git';
import { badRequest } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { resultToResponse } from '../utils/result-response.js';
import { requireProject } from '../utils/route-helpers.js';
import { createWorktreeSchema, deleteWorktreeSchema, validate } from '../validation/schemas.js';

export const worktreeRoutes = new Hono();

// GET /api/worktrees/preview?projectId=xxx&branchName=xxx
worktreeRoutes.get('/preview', async (c) => {
  const projectId = c.req.query('projectId');
  const branchName = c.req.query('branchName');
  if (!projectId || !branchName)
    return resultToResponse(c, err(badRequest('projectId and branchName are required')));

  const projectResult = await requireProject(projectId);
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

  const projectResult = await requireProject(projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

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

  const projectResult = await requireProject(projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

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

  const projectResult = await requireProject(projectId);
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
  const { projectId, worktreePath, branchName, deleteBranch } = parsed.value;

  const projectResult = await requireProject(projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  await removeWorktree(projectResult.value.path, worktreePath);

  if (deleteBranch && branchName) {
    await removeBranch(projectResult.value.path, branchName);
  }

  return c.json({ ok: true });
});
