/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { existsSync } from 'fs';
import { join } from 'path';

import {
  getDiff,
  getDiffSummary,
  getSingleFileDiff,
  getFullContextFileDiff,
  resolveRepoRelativePath,
} from '@funny/core/git';
import { badRequest, type DomainError } from '@funny/shared/errors';
import { Hono, type Context } from 'hono';
import { err, ok, type Result } from 'neverthrow';

import { requestSpan } from '../../middleware/tracing.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireThreadCwd, steerFromContext } from '../../utils/route-helpers.js';
import { requireGitWorkingTree, requireProjectCwd } from './helpers.js';

export const diffRoutes = new Hono<HonoEnv>();

/**
 * Validate a cwd-relative path from the query string (submodule dir or file):
 * no absolute path outside `cwd`, no `..`, and no symlink escaping `cwd`.
 */
function requireContainedPath(cwd: string, rawPath: string): Result<string, DomainError> {
  const safePath = resolveRepoRelativePath(cwd, rawPath);
  return safePath.isOk() ? ok(safePath.value) : err(badRequest(`Invalid path: ${rawPath}`));
}

/** Resolves the request's working directory plus the span attributes naming it. */
type DiffScope = (
  c: Context<HonoEnv>,
) => Promise<{ cwd: Result<string, DomainError>; attrs: Record<string, unknown> }>;

const projectScope: DiffScope = async (c) => ({
  cwd: await requireProjectCwd(
    c.req.param('projectId') as string,
    c.get('userId') as string,
    c.get('organizationId'),
  ),
  attrs: { projectId: c.req.param('projectId') },
});

// Steer sharees reach the thread variants (thread-sharing-steer).
const threadScope: DiffScope = async (c) => ({
  cwd: await requireThreadCwd(
    c.req.param('threadId') as string,
    c.get('userId') as string,
    steerFromContext(c),
  ),
  attrs: { threadId: c.req.param('threadId') },
});

/** Contained, existing nested repo under `cwd` (submodule / nested clone). */
function requireSubmoduleCwd(cwd: string, relPath: string): Result<string, DomainError> {
  return requireContainedPath(cwd, relPath).andThen((rel) => {
    const submoduleCwd = join(cwd, rel);
    return existsSync(submoduleCwd) && existsSync(join(submoduleCwd, '.git'))
      ? ok(submoduleCwd)
      : err(badRequest(`Not a git repository: ${relPath}`));
  });
}

/**
 * Single-file diff. Security (H5): `?path=` is confined to `cwd` (no absolute
 * path outside it, no `..`, no symlink escape) BEFORE it reaches the native
 * reader or `diff --no-index`, which would otherwise read any file on the
 * host. Thread variants are reachable by steer sharees, so this is load-bearing.
 */
async function respondFileDiff(
  c: Context<HonoEnv>,
  cwd: string,
  rawPath: string,
  spanName: string,
  spanAttrs: Record<string, unknown>,
) {
  const safePath = requireContainedPath(cwd, rawPath);
  if (safePath.isErr()) return resultToResponse(c, safePath);
  const filePath = safePath.value;
  const staged = c.req.query('staged') === 'true';
  const fullContext = c.req.query('context') === 'full';
  const span = requestSpan(c, spanName, { ...spanAttrs, path: filePath, fullContext });
  const result = fullContext
    ? await getFullContextFileDiff(cwd, filePath, staged)
    : await getSingleFileDiff(cwd, filePath, staged);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
}

/** GET .../diff/file?path= */
function fileDiffHandler(scope: DiffScope) {
  return async (c: Context<HonoEnv>) => {
    const { cwd, attrs } = await scope(c);
    if (cwd.isErr()) return resultToResponse(c, cwd);
    const filePath = c.req.query('path');
    if (!filePath) {
      return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
    }
    return respondFileDiff(c, cwd.value, filePath, 'git.diff_file', attrs);
  };
}

/** GET .../diff/submodule?path= — diff summary inside a nested repo. */
function submoduleSummaryHandler(scope: DiffScope) {
  return async (c: Context<HonoEnv>) => {
    const { cwd, attrs } = await scope(c);
    if (cwd.isErr()) return resultToResponse(c, cwd);
    const relPath = c.req.query('path');
    if (!relPath) {
      return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
    }
    const submoduleCwd = requireSubmoduleCwd(cwd.value, relPath);
    if (submoduleCwd.isErr()) return resultToResponse(c, submoduleCwd);
    const span = requestSpan(c, 'git.diff_submodule', { ...attrs, path: relPath });
    const result = await getDiffSummary(submoduleCwd.value);
    span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
    if (result.isErr()) return resultToResponse(c, result);
    return c.json(result.value);
  };
}

/**
 * GET .../diff/submodule/file?submodule=&path= — single-file diff scoped
 * *inside* a submodule; `submodule` is relative to the cwd, `path` to the
 * submodule.
 */
function submoduleFileHandler(scope: DiffScope) {
  return async (c: Context<HonoEnv>) => {
    const { cwd, attrs } = await scope(c);
    if (cwd.isErr()) return resultToResponse(c, cwd);
    const submodulePath = c.req.query('submodule');
    const filePath = c.req.query('path');
    if (!submodulePath || !filePath) {
      return resultToResponse(
        c,
        err(badRequest('Missing required query parameters: submodule, path')),
      );
    }
    const submoduleCwd = requireSubmoduleCwd(cwd.value, submodulePath);
    if (submoduleCwd.isErr()) return resultToResponse(c, submoduleCwd);
    return respondFileDiff(c, submoduleCwd.value, filePath, 'git.diff_submodule_file', {
      ...attrs,
      submodule: submodulePath,
    });
  };
}

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
  const workTreeResult = await requireGitWorkingTree(cwd);
  if (workTreeResult.isErr()) return resultToResponse(c, workTreeResult);
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
diffRoutes.get('/project/:projectId/diff/submodule', submoduleSummaryHandler(projectScope));

// GET /api/git/project/:projectId/diff/submodule/file
// Returns a single-file diff scoped *inside* a submodule / nested git repo.
// `submodule` = path of the submodule relative to the project; `path` = file
// path relative to the submodule.
diffRoutes.get('/project/:projectId/diff/submodule/file', submoduleFileHandler(projectScope));

// GET /api/git/project/:projectId/diff/file
diffRoutes.get('/project/:projectId/diff/file', fileDiffHandler(projectScope));

// GET /api/git/:threadId/diff/summary
diffRoutes.get('/:threadId/diff/summary', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, steerFromContext(c));
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  if (!existsSync(cwd)) {
    return resultToResponse(c, err(badRequest(`Working directory does not exist: ${cwd}`)));
  }
  const workTreeResult = await requireGitWorkingTree(cwd);
  if (workTreeResult.isErr()) return resultToResponse(c, workTreeResult);
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
diffRoutes.get('/:threadId/diff/submodule', submoduleSummaryHandler(threadScope));

// GET /api/git/:threadId/diff/submodule/file
// Single-file diff scoped *inside* a submodule of the thread's worktree.
diffRoutes.get('/:threadId/diff/submodule/file', submoduleFileHandler(threadScope));

// GET /api/git/:threadId/diff/file
diffRoutes.get('/:threadId/diff/file', fileDiffHandler(threadScope));

// GET /api/git/:threadId/diff
diffRoutes.get('/:threadId/diff', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, steerFromContext(c));
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  if (!existsSync(cwd)) {
    return resultToResponse(c, err(badRequest(`Working directory does not exist: ${cwd}`)));
  }
  const workTreeResult = await requireGitWorkingTree(cwd);
  if (workTreeResult.isErr()) return resultToResponse(c, workTreeResult);
  const span = requestSpan(c, 'git.diff', { threadId: c.req.param('threadId') });
  const diffResult = await getDiff(cwd);
  span.end(
    diffResult.isOk() ? 'ok' : 'error',
    diffResult.isErr() ? diffResult.error.message : undefined,
  );
  if (diffResult.isErr()) return resultToResponse(c, diffResult);
  return c.json(diffResult.value);
});
