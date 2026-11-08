import { stat } from 'node:fs/promises';

import {
  getCurrentBranch,
  getDefaultBranch,
  git,
  invalidateStatusCache,
  findWorktreeForBranch,
  getGitWriteGeneration,
  listBranchesDetailed,
  stash,
} from '@funny/core/git';
import { createStaleWhileRevalidate } from '@funny/shared/stale-while-revalidate';
import { Hono, type Context } from 'hono';
import { ok, type Result } from 'neverthrow';

import { requestSpan } from '../../middleware/tracing.js';
import { gitRuntimeService } from '../../services/git-runtime-service.js';
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
  // Check on the owning runner before spawning git in a deleted working directory.
  const directoryExists = await stat(project.path).then(
    (entry) => entry.isDirectory(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    },
  );
  if (!directoryExists) {
    return c.json({
      branches: [],
      remoteBranches: [],
      defaultBranch: null,
      currentBranch: null,
      directoryExists: false,
    });
  }
  // Fire-and-forget: fetch remote refs in the background so the response is
  // instant (uses locally cached branch data).
  const identity = userId ? await resolveIdentity(userId, project.id) : undefined;
  gitRuntimeService.scheduleBackgroundFetch({
    projectId: project.id,
    projectPath: project.path,
    identity,
    attrs: { route: 'project.branches' },
  });
  const listing = await branchListingCache.get(`${project.id}|${project.path}`, {
    lookup: async () => ok(await computeBranchListing(c, project.id, project.path)),
    onChanged: () =>
      wsBroker.emitToUser(userId, {
        type: 'git:refs-updated',
        threadId: '',
        data: { projectId: project.id, changed: ['branches'] },
      }),
    version: getGitWriteGeneration(),
  });
  // The lookup never fails (each part falls back on its own); a defect throws.
  if (listing.isErr()) throw listing.error;
  return c.json({ ...listing.value, directoryExists });
});

interface BranchListing {
  branches: string[];
  remoteBranches: string[];
  defaultBranch: string | null;
  currentBranch: string | null;
}

// Stale-while-revalidate: a repo whose branch listing is slow (git pool busy
// behind a fetch, huge ref count) answers with its last listing at once and
// recomputes in the background; a changed listing is pushed as a refetch hint.
// A checkout made through funny bumps the git write generation, so the next
// read waits for a new listing instead of serving the old current branch.
const branchListingCache = createStaleWhileRevalidate<BranchListing, never>({
  freshMs: 2_000,
  maxStaleMs: 10 * 60_000,
  capacity: 200,
  refreshConcurrency: 2,
});

/** Runs a git read inside a request span that records whether it failed. */
async function spanned<T, E extends { message: string }>(
  c: Context<HonoEnv>,
  name: string,
  attrs: Record<string, unknown>,
  run: () => PromiseLike<Result<T, E>>,
): Promise<Result<T, E>> {
  const span = requestSpan(c, name, attrs);
  const r = await run();
  span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
  return r;
}

async function computeBranchListing(
  c: Context<HonoEnv>,
  projectId: string,
  projectPath: string,
): Promise<BranchListing> {
  const attrs = { projectId };
  const [branchesResult, defaultBranchResult, currentBranchResult] = await Promise.all([
    spanned(c, 'git.branches_detailed', attrs, () => listBranchesDetailed(projectPath)),
    spanned(c, 'git.default_branch', attrs, () => getDefaultBranch(projectPath)),
    spanned(c, 'git.current_branch', attrs, () => getCurrentBranch(projectPath)),
  ]);

  const detailed = branchesResult.isOk() ? branchesResult.value : [];
  const defaultBranch = defaultBranchResult.isOk() ? defaultBranchResult.value : 'main';
  const currentBranch = currentBranchResult.isOk() ? currentBranchResult.value : null;

  // Client contract: `branches` = local branch names, `remoteBranches` = names
  // that exist on origin (used by BranchPicker to render the "origin" badge).
  const branches = detailed.filter((b) => b.isLocal).map((b) => b.name);
  const remoteBranches = detailed.filter((b) => b.isRemote).map((b) => b.name);

  return { branches, remoteBranches, defaultBranch, currentBranch };
}

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

  const existingWorktree = await findWorktreeForBranch(project.path, targetBranch);
  if (existingWorktree.isOk() && existingWorktree.value) {
    return c.json({
      canCheckout: true,
      currentBranch,
      hasDirtyFiles: false,
      reason: 'existing_worktree',
      worktreePath: existingWorktree.value,
    });
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

  const existingWorktree = await findWorktreeForBranch(project.path, branch);
  if (existingWorktree.isOk() && existingWorktree.value) {
    if (threadId) {
      await tm.updateThread(threadId, { branch, worktreePath: existingWorktree.value });
      const userId = c.get('userId');
      if (userId) {
        wsBroker.emitToUser(userId, {
          type: 'thread:updated',
          threadId,
          data: { branch, worktreePath: existingWorktree.value },
        });
      }
    }
    return c.json({
      ok: true,
      currentBranch: branch,
      worktreePath: existingWorktree.value,
    });
  }

  if (strategy === 'stash') {
    // Include untracked files (-u) — otherwise new files stay in the working
    // tree and follow the checkout onto the target branch, so "leave my
    // changes" would silently carry them anyway.
    const stashResult = await stash(project.path, true);
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
