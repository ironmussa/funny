/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import {
  push,
  pull,
  getRemoteUrl,
  invalidateStatusCache,
  listGitHubOrgs,
  publishRepo,
  setOrigin,
} from '@funny/core/git';
import { Hono } from 'hono';

import { log } from '../../lib/logger.js';
import { requestSpan } from '../../middleware/tracing.js';
import { gitRuntimeService } from '../../services/git-runtime-service.js';
import {
  pushChanges as gitServicePush,
  pushBranchToOrigin as gitServicePushBranch,
  pullChanges as gitServicePull,
  resolveIdentity,
} from '../../services/git-service.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireThreadCwd } from '../../utils/route-helpers.js';
import {
  validate,
  publishRepoSchema,
  pullSchema,
  pushBranchSchema,
  setRemoteSchema,
} from '../../validation/schemas.js';
import { _gitStatusCache, invalidateGitStatusCache, requireProjectCwd } from './helpers.js';

export const remoteRoutes = new Hono<HonoEnv>();

// POST /api/git/project/:projectId/push
remoteRoutes.post('/project/:projectId/push', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const identity = await resolveIdentity(userId);
  const result = await push(cwdResult.value, identity);
  if (result.isErr()) return resultToResponse(c, result);
  // Invalidate BOTH caches: the bulk per-project HTTP cache AND the core
  // cwd-keyed summary cache (1s TTL) — otherwise an immediate post-push
  // status recompute can return a stale unpushed count.
  invalidateStatusCache(cwdResult.value);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/push-branch — push a specific local branch.
remoteRoutes.post('/project/:projectId/push-branch', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const parsed = validate(pushBranchSchema, await c.req.json().catch(() => ({})));
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const result = await gitServicePushBranch(
    projectId,
    userId,
    cwdResult.value,
    parsed.value.branch,
  );
  if (result.isErr()) return resultToResponse(c, result);
  invalidateStatusCache(cwdResult.value);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// GET /api/git/project/:projectId/remote-url
remoteRoutes.get('/project/:projectId/remote-url', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const span = requestSpan(c, 'git.remote_url', { projectId });
  const result = await getRemoteUrl(cwdResult.value);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ remoteUrl: result.value });
});

// POST /api/git/project/:projectId/remote
// Add or update the `origin` remote for a project that was initialized
// locally with no remote configured (GitHub Desktop-style "add remote").
remoteRoutes.post('/project/:projectId/remote', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const parsed = validate(setRemoteSchema, await c.req.json().catch(() => ({})));
  if (parsed.isErr()) return resultToResponse(c, parsed);
  log.info('git.setOrigin', { namespace: 'git', projectId });
  const result = await setOrigin(cwdResult.value, parsed.value.url);
  if (result.isErr()) {
    log.error('git.setOrigin.failed', {
      namespace: 'git',
      projectId,
      error: String(result.error),
    });
    return resultToResponse(c, result);
  }
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true });
});

// GET /api/git/project/:projectId/gh-orgs
remoteRoutes.get('/project/:projectId/gh-orgs', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const identity = await resolveIdentity(userId);
  if (!identity?.githubToken) {
    return c.json({ orgs: [] });
  }
  const span = requestSpan(c, 'github.orgs', { projectId });
  const result = await listGitHubOrgs(cwdResult.value, { GH_TOKEN: identity.githubToken });
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ orgs: result.value });
});

// POST /api/git/project/:projectId/publish
remoteRoutes.post('/project/:projectId/publish', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const identity = await resolveIdentity(userId);
  if (!identity?.githubToken) {
    return c.json({ error: 'GitHub token required. Set one in Settings > Profile.' }, 400);
  }
  const parsed = validate(publishRepoSchema, await c.req.json());
  if (parsed.isErr()) return resultToResponse(c, parsed);
  log.info('git.publish', { namespace: 'git', projectId, repoName: parsed.value.name });
  const result = await publishRepo(cwdResult.value, parsed.value, {
    GH_TOKEN: identity.githubToken,
  });
  if (result.isErr()) {
    log.error('git.publish.failed', { namespace: 'git', projectId, error: String(result.error) });
    return resultToResponse(c, result);
  }
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, repoUrl: result.value });
});

// POST /api/git/project/:projectId/pull
remoteRoutes.post('/project/:projectId/pull', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(pullSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const identity = await resolveIdentity(userId);
  const result = await pull(cwdResult.value, parsed.value.strategy, identity);
  if (result.isErr()) return resultToResponse(c, result);
  // Pull advanced HEAD and the origin ref — drop the stale cwd-keyed summary so
  // the unpulled badge clears on the very next status read instead of lingering.
  invalidateStatusCache(cwdResult.value);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/fetch
remoteRoutes.post('/project/:projectId/fetch', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const identity = await resolveIdentity(userId);
  const result = await gitRuntimeService.fetchProject(projectId, {
    cwd: cwdResult.value,
    identity,
  });
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/push
remoteRoutes.post('/:threadId/push', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const span = requestSpan(c, 'git.push', { threadId });
  const result = await gitServicePush(threadId, userId, cwdResult.value);
  if (result.isErr()) {
    span.end('error', result.error.message);
    return resultToResponse(c, result);
  }
  invalidateStatusCache(cwdResult.value);
  await invalidateGitStatusCache(threadId);
  span.end('ok');
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/push-branch — push a specific local branch.
remoteRoutes.post('/:threadId/push-branch', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const parsed = validate(pushBranchSchema, await c.req.json().catch(() => ({})));
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const result = await gitServicePushBranch(threadId, userId, cwdResult.value, parsed.value.branch);
  if (result.isErr()) return resultToResponse(c, result);
  invalidateStatusCache(cwdResult.value);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/pull
remoteRoutes.post('/:threadId/pull', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(pullSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await gitServicePull(threadId, userId, cwdResult.value, parsed.value.strategy);
  if (result.isErr()) return resultToResponse(c, result);
  invalidateStatusCache(cwdResult.value);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/fetch
remoteRoutes.post('/:threadId/fetch', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const identity = await resolveIdentity(userId);
  const result = await gitRuntimeService.fetchThread(threadId, {
    cwd: cwdResult.value,
    identity,
  });
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});
