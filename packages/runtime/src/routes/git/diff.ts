/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { existsSync } from 'fs';

import {
  getDiff,
  getDiffSummary,
  getSingleFileDiff,
  getFullContextFileDiff,
} from '@funny/core/git';
import { badRequest } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { requestSpan } from '../../middleware/tracing.js';
import { validateFilePaths } from '../../services/git-service.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireThreadCwd } from '../../utils/route-helpers.js';
import { requireProjectCwd } from './helpers.js';

export const diffRoutes = new Hono<HonoEnv>();

// GET /api/git/project/:projectId/diff/summary
diffRoutes.get('/project/:projectId/diff/summary', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  if (!existsSync(cwd)) {
    return resultToResponse(c, err(badRequest(`Working directory does not exist: ${cwd}`)));
  }
  const excludeRaw = c.req.query('exclude');
  const excludePatterns = excludeRaw
    ? excludeRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const maxFilesRaw = c.req.query('maxFiles');
  const maxFiles = maxFilesRaw ? parseInt(maxFilesRaw, 10) : undefined;
  const projectId = c.req.param('projectId');
  const span = requestSpan(c, 'git.diff_summary', { projectId });
  const result = await getDiffSummary(cwd, { excludePatterns, maxFiles });
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json(result.value);
});

// GET /api/git/project/:projectId/diff/submodule
diffRoutes.get('/project/:projectId/diff/submodule', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const relPath = c.req.query('path');
  if (!relPath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const pathCheck = validateFilePaths(cwd, [relPath]);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  const { join } = await import('node:path');
  const submoduleCwd = join(cwd, relPath);
  if (!existsSync(submoduleCwd) || !existsSync(join(submoduleCwd, '.git'))) {
    return resultToResponse(c, err(badRequest(`Not a git repository: ${relPath}`)));
  }
  const span = requestSpan(c, 'git.diff_submodule', {
    projectId: c.req.param('projectId'),
    path: relPath,
  });
  const result = await getDiffSummary(submoduleCwd);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json(result.value);
});

// GET /api/git/project/:projectId/diff/submodule/file
// Returns a single-file diff scoped *inside* a submodule / nested git repo.
// `submodule` = path of the submodule relative to the project; `path` = file
// path relative to the submodule.
diffRoutes.get('/project/:projectId/diff/submodule/file', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const submodulePath = c.req.query('submodule');
  const filePath = c.req.query('path');
  if (!submodulePath || !filePath) {
    return resultToResponse(
      c,
      err(badRequest('Missing required query parameters: submodule, path')),
    );
  }
  const pathCheck = validateFilePaths(cwd, [submodulePath]);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  const { join } = await import('node:path');
  const submoduleCwd = join(cwd, submodulePath);
  if (!existsSync(submoduleCwd) || !existsSync(join(submoduleCwd, '.git'))) {
    return resultToResponse(c, err(badRequest(`Not a git repository: ${submodulePath}`)));
  }
  const innerCheck = validateFilePaths(submoduleCwd, [filePath]);
  if (innerCheck.isErr()) return resultToResponse(c, innerCheck);
  const staged = c.req.query('staged') === 'true';
  const fullContext = c.req.query('context') === 'full';
  const span = requestSpan(c, 'git.diff_submodule_file', {
    projectId: c.req.param('projectId'),
    submodule: submodulePath,
    path: filePath,
    fullContext,
  });
  const result = fullContext
    ? await getFullContextFileDiff(submoduleCwd, filePath, staged)
    : await getSingleFileDiff(submoduleCwd, filePath, staged);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});

// GET /api/git/project/:projectId/diff/file
diffRoutes.get('/project/:projectId/diff/file', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const filePath = c.req.query('path');
  if (!filePath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const staged = c.req.query('staged') === 'true';
  const fullContext = c.req.query('context') === 'full';
  const span = requestSpan(c, 'git.diff_file', {
    projectId: c.req.param('projectId'),
    path: filePath,
    fullContext,
  });
  const result = fullContext
    ? await getFullContextFileDiff(cwd, filePath, staged)
    : await getSingleFileDiff(cwd, filePath, staged);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});

// GET /api/git/:threadId/diff/summary
diffRoutes.get('/:threadId/diff/summary', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  if (!existsSync(cwd)) {
    return resultToResponse(c, err(badRequest(`Working directory does not exist: ${cwd}`)));
  }
  const excludeRaw = c.req.query('exclude');
  const excludePatterns = excludeRaw
    ? excludeRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const maxFilesRaw = c.req.query('maxFiles');
  const maxFiles = maxFilesRaw ? parseInt(maxFilesRaw, 10) : undefined;
  const span = requestSpan(c, 'git.diff_summary', { threadId: c.req.param('threadId') });
  const result = await getDiffSummary(cwd, { excludePatterns, maxFiles });
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json(result.value);
});

// GET /api/git/:threadId/diff/submodule
// Returns a diff summary for the inside of a submodule / nested git repo,
// scoped by the submodule's path relative to the thread cwd.
diffRoutes.get('/:threadId/diff/submodule', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const relPath = c.req.query('path');
  if (!relPath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const pathCheck = validateFilePaths(cwd, [relPath]);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  const { join } = await import('node:path');
  const submoduleCwd = join(cwd, relPath);
  if (!existsSync(submoduleCwd) || !existsSync(join(submoduleCwd, '.git'))) {
    return resultToResponse(c, err(badRequest(`Not a git repository: ${relPath}`)));
  }
  const span = requestSpan(c, 'git.diff_submodule', {
    threadId: c.req.param('threadId'),
    path: relPath,
  });
  const result = await getDiffSummary(submoduleCwd);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json(result.value);
});

// GET /api/git/:threadId/diff/submodule/file
// Single-file diff scoped *inside* a submodule of the thread's worktree.
diffRoutes.get('/:threadId/diff/submodule/file', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const submodulePath = c.req.query('submodule');
  const filePath = c.req.query('path');
  if (!submodulePath || !filePath) {
    return resultToResponse(
      c,
      err(badRequest('Missing required query parameters: submodule, path')),
    );
  }
  const pathCheck = validateFilePaths(cwd, [submodulePath]);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  const { join } = await import('node:path');
  const submoduleCwd = join(cwd, submodulePath);
  if (!existsSync(submoduleCwd) || !existsSync(join(submoduleCwd, '.git'))) {
    return resultToResponse(c, err(badRequest(`Not a git repository: ${submodulePath}`)));
  }
  const innerCheck = validateFilePaths(submoduleCwd, [filePath]);
  if (innerCheck.isErr()) return resultToResponse(c, innerCheck);
  const staged = c.req.query('staged') === 'true';
  const fullContext = c.req.query('context') === 'full';
  const span = requestSpan(c, 'git.diff_submodule_file', {
    threadId: c.req.param('threadId'),
    submodule: submodulePath,
    path: filePath,
    fullContext,
  });
  const result = fullContext
    ? await getFullContextFileDiff(submoduleCwd, filePath, staged)
    : await getSingleFileDiff(submoduleCwd, filePath, staged);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});

// GET /api/git/:threadId/diff/file
diffRoutes.get('/:threadId/diff/file', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const filePath = c.req.query('path');
  if (!filePath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const staged = c.req.query('staged') === 'true';
  const fullContext = c.req.query('context') === 'full';
  const span = requestSpan(c, 'git.diff_file', {
    threadId: c.req.param('threadId'),
    path: filePath,
    fullContext,
  });
  const result = fullContext
    ? await getFullContextFileDiff(cwd, filePath, staged)
    : await getSingleFileDiff(cwd, filePath, staged);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});

// GET /api/git/:threadId/diff
diffRoutes.get('/:threadId/diff', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  if (!existsSync(cwd)) {
    return resultToResponse(c, err(badRequest(`Working directory does not exist: ${cwd}`)));
  }
  const span = requestSpan(c, 'git.diff', { threadId: c.req.param('threadId') });
  const diffResult = await getDiff(cwd);
  span.end(
    diffResult.isOk() ? 'ok' : 'error',
    diffResult.isErr() ? diffResult.error.message : undefined,
  );
  if (diffResult.isErr()) return resultToResponse(c, diffResult);
  return c.json(diffResult.value);
});
