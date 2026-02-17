import { Hono } from 'hono';
import { createWorktree, listWorktrees, removeWorktree } from '@funny/core/git';
import { createWorktreeSchema, deleteWorktreeSchema, validate } from '../validation/schemas.js';
import { requireProject } from '../utils/route-helpers.js';
import { resultToResponse } from '../utils/result-response.js';
import { badRequest } from '@funny/shared/errors';
import { err } from 'neverthrow';

export const worktreeRoutes = new Hono();

// GET /api/worktrees?projectId=xxx
worktreeRoutes.get('/', async (c) => {
  const projectId = c.req.query('projectId');
  if (!projectId) return resultToResponse(c, err(badRequest('projectId is required')));

  const projectResult = requireProject(projectId);
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

  const projectResult = requireProject(projectId);
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
  const { projectId, worktreePath } = parsed.value;

  const projectResult = requireProject(projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  await removeWorktree(projectResult.value.path, worktreePath);
  return c.json({ ok: true });
});
