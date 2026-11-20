/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: GitService
 */

import { Hono, type Context } from 'hono';

import { canDoGitOps, isWorktreeCheckoutMissing } from '../services/thread-context.js';
import * as tm from '../services/thread-manager.js';
import type { HonoEnv } from '../types/hono-env.js';
import { commitRoutes } from './git/commit.js';
import { diffRoutes } from './git/diff.js';
import { invalidateGitStatusCacheByProject } from './git/helpers.js';
import { logRoutes } from './git/log.js';
import { remoteRoutes } from './git/remote.js';
import { stageRoutes } from './git/stage.js';
import { stashRoutes } from './git/stash.js';
import { statusRoutes } from './git/status.js';
import { workflowRoutes } from './git/workflow.js';

export { invalidateGitStatusCacheByProject };

export const gitRoutes = new Hono<HonoEnv>();

/**
 * Refuse git operations a thread cannot run: a scratch thread has no repo,
 * and a worktree thread whose checkout was removed outside funny would only
 * get git's "not a git repository" for every request.
 */
async function rejectThreadWithoutGit(c: Context<HonoEnv>, threadId: string) {
  const thread = await tm.getThread(threadId);
  // Unknown thread: let the sub-route answer 404.
  if (!thread) return null;
  if (!canDoGitOps(thread)) {
    return c.json(
      {
        error: 'Git operations are not available for scratch threads',
        code: 'git-not-allowed-for-scratch',
      },
      400,
    );
  }
  if (isWorktreeCheckoutMissing(thread)) {
    return c.json(
      {
        error: `This thread's worktree no longer exists at ${thread.worktreePath}. It was removed outside funny (for example with \`git worktree remove\`). Archive the thread, or create a new one from its branch if you still need it.`,
        code: 'worktree-missing',
      },
      409,
    );
  }
  return null;
}

// Sub-routes take the thread as `?threadId=` (project routes) or as the
// `:threadId` path segment. When neither is present, fall through; the
// sub-route already validates `projectId`.
gitRoutes.use('*', async (c, next) => {
  const threadId = c.req.query('threadId');
  if (!threadId) return next();
  return (await rejectThreadWithoutGit(c, threadId)) ?? next();
});

gitRoutes.use('/:threadId/*', async (c, next) => {
  const threadId = c.req.param('threadId');
  // `/project/:projectId/*` shares the shape; the `*` guard above covers it.
  if (!threadId || threadId === 'project' || c.req.query('threadId')) return next();
  return (await rejectThreadWithoutGit(c, threadId)) ?? next();
});

gitRoutes.route('/', statusRoutes);
gitRoutes.route('/', diffRoutes);
gitRoutes.route('/', logRoutes);
gitRoutes.route('/', stashRoutes);
gitRoutes.route('/', stageRoutes);
gitRoutes.route('/', commitRoutes);
gitRoutes.route('/', remoteRoutes);
gitRoutes.route('/', workflowRoutes);
