/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: GitService
 */

import { Hono } from 'hono';

import { canDoGitOps } from '../services/thread-context.js';
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

// Reject git operations on scratch threads. Sub-routes use a mix of
// `?threadId=` and `:threadId` params — check both. When neither is
// present, fall through; the sub-route already validates `projectId`.
gitRoutes.use('*', async (c, next) => {
  const threadId = c.req.query('threadId') ?? c.req.param('threadId');
  if (!threadId) return next();
  const thread = await tm.getThread(threadId);
  if (thread && !canDoGitOps(thread as unknown as { isScratch: boolean })) {
    return c.json(
      {
        error: 'Git operations are not available for scratch threads',
        code: 'git-not-allowed-for-scratch',
      },
      400,
    );
  }
  return next();
});

gitRoutes.route('/', statusRoutes);
gitRoutes.route('/', diffRoutes);
gitRoutes.route('/', logRoutes);
gitRoutes.route('/', stashRoutes);
gitRoutes.route('/', stageRoutes);
gitRoutes.route('/', commitRoutes);
gitRoutes.route('/', remoteRoutes);
gitRoutes.route('/', workflowRoutes);
