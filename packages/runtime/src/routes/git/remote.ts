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
import { isString } from '../../lib/value-guards.js';
import { gitRuntimeService } from '../../services/git-runtime-service.js';
import {
  pushChanges as gitServicePush,
  pushBranchToOrigin as gitServicePushBranch,
  pullChanges as gitServicePull,
  resolveIdentity,
  resolveThreadIdentity,
} from '../../services/git-service.js';
import { recordedGithubWrite } from '../../services/github-write-activity.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import {
  validate,
  publishRepoSchema,
  pullSchema,
  pushBranchSchema,
  setRemoteSchema,
} from '../../validation/schemas.js';
import {
  okOnly,
  projectGitMutation,
  threadGitMutation,
  traced,
  withProjectCheckout,
  withThreadCheckout,
} from './checkout-route.js';
import { gitStatusCache } from './helpers.js';

export const remoteRoutes = new Hono<HonoEnv>();

// A push or pull moves HEAD and the origin ref: also drop the core cwd-keyed
// summary cache (1s TTL), or an immediate status read returns a stale count.
/** The GitHub token the caller's identity carries for the project, if any. */
async function githubTokenOf(userId: string, projectId: string): Promise<string | undefined> {
  return (await resolveIdentity(userId, projectId))?.githubToken;
}

const dropStatusSummary = ({ cwd }: { cwd: string }) => invalidateStatusCache(cwd);

// ── Project checkout (/project/:projectId) ──────────────────────────────────

// POST /api/git/project/:projectId/push
remoteRoutes.post('/project/:projectId/push', (c) =>
  projectGitMutation(c, {
    run: async ({ projectId, userId, cwd }) => push(cwd, await resolveIdentity(userId, projectId)),
    after: dropStatusSummary,
  }),
);

// POST /api/git/project/:projectId/push-branch — push a specific local branch.
remoteRoutes.post('/project/:projectId/push-branch', (c) =>
  projectGitMutation(c, {
    body: pushBranchSchema,
    run: ({ projectId, userId, cwd }, { branch }) =>
      gitServicePushBranch(projectId, userId, cwd, branch),
    after: dropStatusSummary,
  }),
);

// GET /api/git/project/:projectId/remote-url
remoteRoutes.get('/project/:projectId/remote-url', (c) =>
  withProjectCheckout(c, async ({ projectId, cwd }) => {
    const result = await traced(c, 'git.remote_url', { projectId }, () => getRemoteUrl(cwd));
    if (result.isErr()) return resultToResponse(c, result);
    return c.json({ remoteUrl: result.value });
  }),
);

// POST /api/git/project/:projectId/remote
// Add or update the `origin` remote for a project that was initialized
// locally with no remote configured (GitHub Desktop-style "add remote").
remoteRoutes.post('/project/:projectId/remote', (c) =>
  projectGitMutation(c, {
    body: setRemoteSchema,
    run: async ({ projectId, cwd }, { url }) => {
      log.info('git.setOrigin', { namespace: 'git', projectId });
      const result = await setOrigin(cwd, url);
      if (result.isErr()) {
        log.error('git.setOrigin.failed', {
          namespace: 'git',
          projectId,
          error: String(result.error),
        });
      }
      return result;
    },
    respond: okOnly,
  }),
);

// GET /api/git/project/:projectId/gh-orgs
remoteRoutes.get('/project/:projectId/gh-orgs', (c) =>
  withProjectCheckout(c, async ({ projectId, userId, cwd }) => {
    const token = await githubTokenOf(userId, projectId);
    if (!token) return c.json({ orgs: [] });
    const result = await traced(c, 'github.orgs', { projectId }, () =>
      listGitHubOrgs(cwd, { GH_TOKEN: token }),
    );
    if (result.isErr()) return resultToResponse(c, result);
    return c.json({ orgs: result.value });
  }),
);

// POST /api/git/project/:projectId/publish
remoteRoutes.post('/project/:projectId/publish', (c) =>
  withProjectCheckout(c, async ({ projectId, userId, cwd }) => {
    const token = await githubTokenOf(userId, projectId);
    if (!token) {
      return c.json({ error: 'GitHub token required. Set one in Settings > Profile.' }, 400);
    }
    const parsed = validate(publishRepoSchema, await c.req.json());
    if (parsed.isErr()) return resultToResponse(c, parsed);
    const repo = parsed.value;
    log.info('git.publish', { namespace: 'git', projectId, repoName: repo.name });
    // Recorded as a `github.write` activity (track-user-and-scheduled-actions).
    return recordedGithubWrite(
      {
        userId,
        projectId,
        title: `Publish ${repo.name} to GitHub`,
        input: { action: 'repo-publish', repo: repo.name },
        effectsOf: (body) => [
          {
            effect: 'repo-published',
            target: isString(body.repoUrl) ? body.repoUrl : repo.name,
          },
        ],
      },
      async () => {
        const result = await publishRepo(cwd, repo, { GH_TOKEN: token });
        if (result.isErr()) {
          log.error('git.publish.failed', {
            namespace: 'git',
            projectId,
            error: String(result.error),
          });
          return resultToResponse(c, result);
        }
        gitStatusCache.delete(projectId);
        return c.json({ ok: true, repoUrl: result.value });
      },
    );
  }),
);

// POST /api/git/project/:projectId/pull
remoteRoutes.post('/project/:projectId/pull', (c) =>
  projectGitMutation(c, {
    body: pullSchema,
    run: async ({ projectId, userId, cwd }, { strategy }) =>
      pull(cwd, strategy, await resolveIdentity(userId, projectId)),
    // Pull advanced HEAD and the origin ref: the unpulled badge clears on the next read.
    after: dropStatusSummary,
  }),
);

// POST /api/git/project/:projectId/fetch
remoteRoutes.post('/project/:projectId/fetch', (c) =>
  withProjectCheckout(c, async ({ projectId, userId, cwd }) => {
    const identity = await resolveIdentity(userId, projectId);
    const result = await gitRuntimeService.fetchProject(projectId, { cwd, identity });
    if (result.isErr()) return resultToResponse(c, result);
    return c.json({ ok: true });
  }),
);

// ── Thread checkout (/:threadId) ────────────────────────────────────────────

// POST /api/git/:threadId/push
remoteRoutes.post('/:threadId/push', (c) =>
  threadGitMutation(c, {
    run: ({ threadId, userId, cwd }) =>
      traced(c, 'git.push', { threadId }, () => gitServicePush(threadId, userId, cwd)),
    after: dropStatusSummary,
  }),
);

// POST /api/git/:threadId/push-branch — push a specific local branch.
remoteRoutes.post('/:threadId/push-branch', (c) =>
  threadGitMutation(c, {
    body: pushBranchSchema,
    run: ({ threadId, userId, cwd }, { branch }) =>
      gitServicePushBranch(threadId, userId, cwd, branch),
    after: dropStatusSummary,
  }),
);

// POST /api/git/:threadId/pull
remoteRoutes.post('/:threadId/pull', (c) =>
  threadGitMutation(c, {
    body: pullSchema,
    run: ({ threadId, userId, cwd }, { strategy }) =>
      gitServicePull(threadId, userId, cwd, strategy),
    after: dropStatusSummary,
  }),
);

// POST /api/git/:threadId/fetch
remoteRoutes.post('/:threadId/fetch', (c) =>
  withThreadCheckout(c, async ({ threadId, userId, cwd }) => {
    const identity = await resolveThreadIdentity(userId, threadId);
    const result = await gitRuntimeService.fetchThread(threadId, { cwd, identity });
    if (result.isErr()) return resultToResponse(c, result);
    return c.json({ ok: true });
  }),
);
