/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import {
  stash,
  stashFiles,
  stashPop,
  stashDrop,
  stashList,
  stashShow,
  stashFileDiff,
} from '@funny/core/git';
import { badRequest } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { requestSpan } from '../../middleware/tracing.js';
import {
  stashChanges as gitServiceStash,
  stashSelectedFiles as gitServiceStashFiles,
  popStash as gitServicePopStash,
  dropStash as gitServiceDropStash,
} from '../../services/git-service.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireThreadCwd } from '../../utils/route-helpers.js';
import { _gitStatusCache, invalidateGitStatusCache, requireProjectCwd } from './helpers.js';

export const stashRoutes = new Hono<HonoEnv>();

// GET /api/git/project/:projectId/stash/list
stashRoutes.get('/project/:projectId/stash/list', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const span = requestSpan(c, 'git.stash_list', { projectId: c.req.param('projectId') });
  const result = await stashList(cwdResult.value);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ entries: result.value });
});

// GET /api/git/project/:projectId/stash/show/:stashIndex
stashRoutes.get('/project/:projectId/stash/show/:stashIndex', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const stashRef = `stash@{${c.req.param('stashIndex')}}`;
  const span = requestSpan(c, 'git.stash_show', {
    projectId: c.req.param('projectId'),
    stashIndex: c.req.param('stashIndex'),
  });
  const result = await stashShow(cwdResult.value, stashRef);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ files: result.value });
});

// GET /api/git/project/:projectId/stash/:stashIndex/diff?path=...
stashRoutes.get('/project/:projectId/stash/:stashIndex/diff', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const filePath = c.req.query('path');
  if (!filePath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const stashRef = `stash@{${c.req.param('stashIndex')}}`;
  const span = requestSpan(c, 'git.stash_diff', {
    projectId: c.req.param('projectId'),
    stashIndex: c.req.param('stashIndex'),
    path: filePath,
  });
  const result = await stashFileDiff(cwdResult.value, stashRef, filePath);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});

// POST /api/git/project/:projectId/stash
stashRoutes.post('/project/:projectId/stash', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const body = await c.req.json().catch(() => ({}));
  const files = Array.isArray(body.files) ? body.files : [];
  const result =
    files.length > 0 ? await stashFiles(cwdResult.value, files) : await stash(cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/stash/pop
stashRoutes.post('/project/:projectId/stash/pop', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const result = await stashPop(cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/stash/drop/:stashIndex
stashRoutes.post('/project/:projectId/stash/drop/:stashIndex', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const stashIndex = parseInt(c.req.param('stashIndex'), 10);
  if (Number.isNaN(stashIndex) || stashIndex < 0) {
    return resultToResponse(c, err(badRequest('Invalid stash index')));
  }
  const result = await stashDrop(cwdResult.value, `stash@{${stashIndex}}`);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/stash
stashRoutes.post('/:threadId/stash', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const cwdResult = await requireThreadCwd(threadId, userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const body = await c.req.json().catch(() => ({}));
  const files = Array.isArray(body.files) ? body.files : [];
  const result =
    files.length > 0
      ? await gitServiceStashFiles(threadId, userId, cwdResult.value, files)
      : await gitServiceStash(threadId, userId, cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/stash/pop
stashRoutes.post('/:threadId/stash/pop', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const cwdResult = await requireThreadCwd(threadId, userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const result = await gitServicePopStash(threadId, userId, cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/stash/drop/:stashIndex
stashRoutes.post('/:threadId/stash/drop/:stashIndex', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const cwdResult = await requireThreadCwd(threadId, userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const stashIndex = parseInt(c.req.param('stashIndex'), 10);
  if (Number.isNaN(stashIndex) || stashIndex < 0) {
    return resultToResponse(c, err(badRequest('Invalid stash index')));
  }
  const result = await gitServiceDropStash(threadId, userId, cwdResult.value, stashIndex);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// GET /api/git/:threadId/stash/list
stashRoutes.get('/:threadId/stash/list', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const span = requestSpan(c, 'git.stash_list', { threadId: c.req.param('threadId') });
  const result = await stashList(cwdResult.value);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ entries: result.value });
});

// GET /api/git/:threadId/stash/show/:stashIndex
stashRoutes.get('/:threadId/stash/show/:stashIndex', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const stashRef = `stash@{${c.req.param('stashIndex')}}`;
  const span = requestSpan(c, 'git.stash_show', {
    threadId: c.req.param('threadId'),
    stashIndex: c.req.param('stashIndex'),
  });
  const result = await stashShow(cwdResult.value, stashRef);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ files: result.value });
});

// GET /api/git/:threadId/stash/:stashIndex/diff?path=...
stashRoutes.get('/:threadId/stash/:stashIndex/diff', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const filePath = c.req.query('path');
  if (!filePath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const stashRef = `stash@{${c.req.param('stashIndex')}}`;
  const span = requestSpan(c, 'git.stash_diff', {
    threadId: c.req.param('threadId'),
    stashIndex: c.req.param('stashIndex'),
    path: filePath,
  });
  const result = await stashFileDiff(cwdResult.value, stashRef, filePath);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});
