import {
  fetchRemote,
  getCurrentBranch,
  getDefaultBranch,
  git,
  invalidateStatusCache,
  listBranchesDetailed,
  stash,
} from '@funny/core/git';
import { Hono } from 'hono';

import { requestSpan } from '../../middleware/tracing.js';
import { resolveIdentity } from '../../services/git-service.js';
import * as tm from '../../services/thread-manager.js';
import { wsBroker } from '../../services/ws-broker.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireProject } from '../../utils/route-helpers.js';

export const projectGitRoutes = new Hono<HonoEnv>();

// GET /api/projects/:id/branches
projectGitRoutes.get('/:id/branches', async (c) => {
  const userId = c.get('userId');
  const orgId = c.get('organizationId') ?? undefined;
  const projectResult = await requireProject(c.req.param('id'), userId, orgId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const project = projectResult.value;
  // Fire-and-forget: fetch remote refs in the background so the response is
  // instant (uses locally cached branch data).
  const identity = userId ? await resolveIdentity(userId) : undefined;
  void fetchRemote(project.path, identity);
  const [branchesResult, defaultBranchResult, currentBranchResult] = await Promise.all([
    (async () => {
      const span = requestSpan(c, 'git.branches_detailed', { projectId: project.id });
      const r = await listBranchesDetailed(project.path);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
    (async () => {
      const span = requestSpan(c, 'git.default_branch', { projectId: project.id });
      const r = await getDefaultBranch(project.path);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
    (async () => {
      const span = requestSpan(c, 'git.current_branch', { projectId: project.id });
      const r = await getCurrentBranch(project.path);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
  ]);

  const detailed = branchesResult.isOk() ? branchesResult.value : [];
  const defaultBranch = defaultBranchResult.isOk() ? defaultBranchResult.value : 'main';
  const currentBranch = currentBranchResult.isOk() ? currentBranchResult.value : null;

  return c.json({ branches: detailed, defaultBranch, currentBranch });
});

// GET /api/projects/:id/checkout-preflight?branch=<branch>
projectGitRoutes.get('/:id/checkout-preflight', async (c) => {
  const projectResult = await requireProject(
    c.req.param('id'),
    c.get('userId'),
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const targetBranch = c.req.query('branch');
  if (!targetBranch) return c.json({ error: 'Missing required query parameter: branch' }, 400);

  const project = projectResult.value;

  const currentBranchResult = await getCurrentBranch(project.path);
  const currentBranch = currentBranchResult.isOk() ? currentBranchResult.value : null;

  if (currentBranch === targetBranch) {
    return c.json({ canCheckout: true, currentBranch, hasDirtyFiles: false });
  }

  const statusResult = await git(['status', '--porcelain'], project.path);
  if (statusResult.isErr()) {
    return c.json({
      canCheckout: false,
      currentBranch,
      reason: 'git_status_failed',
      hasDirtyFiles: false,
    });
  }

  const dirtyFiles = statusResult.value
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.slice(3).trim());

  if (dirtyFiles.length === 0) {
    return c.json({ canCheckout: true, currentBranch, hasDirtyFiles: false });
  }

  return c.json({
    canCheckout: false,
    currentBranch,
    reason: 'dirty_files',
    hasDirtyFiles: true,
    dirtyFileCount: dirtyFiles.length,
  });
});

// POST /api/projects/:id/checkout — perform branch checkout with a strategy for dirty files
projectGitRoutes.post('/:id/checkout', async (c) => {
  const projectResult = await requireProject(
    c.req.param('id'),
    c.get('userId'),
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const body = await c.req.json<{
    branch: string;
    strategy?: 'stash' | 'carry';
    create?: boolean;
    threadId?: string;
  }>();
  const { branch, strategy = 'carry', create = false, threadId } = body;
  if (!branch) return c.json({ error: 'Missing required field: branch' }, 400);

  const project = projectResult.value;

  const currentBranchResult = await getCurrentBranch(project.path);
  const currentBranch = currentBranchResult.isOk() ? currentBranchResult.value : null;
  if (currentBranch === branch) {
    return c.json({ ok: true, currentBranch: branch });
  }

  if (strategy === 'stash') {
    const stashResult = await stash(project.path);
    if (stashResult.isErr()) {
      return c.json({ error: `Failed to stash: ${stashResult.error.message}` }, 500);
    }
  }

  const checkoutArgs = create ? ['checkout', '-b', branch] : ['checkout', branch];
  const checkoutResult = await git(checkoutArgs, project.path);
  if (checkoutResult.isErr()) {
    if (strategy === 'stash') {
      await git(['stash', 'pop'], project.path);
    }
    return c.json({ error: `Checkout failed: ${checkoutResult.error.message}` }, 500);
  }

  invalidateStatusCache(project.path);

  if (threadId) {
    await tm.updateThread(threadId, { branch });
    const userId = c.get('userId');
    if (userId) {
      wsBroker.emitToUser(userId, {
        type: 'thread:updated',
        threadId,
        data: { branch },
      });
    }
  }

  return c.json({ ok: true, currentBranch: branch });
});
