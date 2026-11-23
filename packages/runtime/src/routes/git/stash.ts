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
import { badRequest, type DomainError } from '@funny/shared/errors';
import { Hono, type Context } from 'hono';
import { err, ok, type Result } from 'neverthrow';

import { stashDropTracked, threadTarget } from '../../services/git-destructive.js';
import {
  stashChanges as gitServiceStash,
  stashSelectedFiles as gitServiceStashFiles,
  popStash as gitServicePopStash,
  dropStash as gitServiceDropStash,
} from '../../services/git-service.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { stashSchema } from '../../validation/schemas.js';
import {
  onBothCheckouts,
  projectGitMutation,
  threadGitMutation,
  traced,
} from './checkout-route.js';

export const stashRoutes = new Hono<HonoEnv>();

/** The files to stash (empty = everything); each must stay inside the checkout. */
const stashedFiles = (body: { files?: string[] }) => body.files ?? [];

/** The route's `:stashIndex`, a non-negative integer. */
function stashIndexOf(c: Context<HonoEnv>): Result<number, DomainError> {
  const stashIndex = parseInt(c.req.param('stashIndex') ?? '', 10);
  return Number.isNaN(stashIndex) || stashIndex < 0
    ? err(badRequest('Invalid stash index'))
    : ok(stashIndex);
}

const stashRefOf = (c: Context<HonoEnv>) => `stash@{${c.req.param('stashIndex')}}`;

// ── Reads, the same on a project and on a thread checkout ──────────────────

// GET /api/git/(project/:projectId | :threadId)/stash/list
onBothCheckouts(stashRoutes, 'GET', '/stash/list', async (c, { cwd, ids }) => {
  const result = await traced(c, 'git.stash_list', ids, () => stashList(cwd));
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ entries: result.value });
});

// GET /api/git/(project/:projectId | :threadId)/stash/show/:stashIndex
onBothCheckouts(stashRoutes, 'GET', '/stash/show/:stashIndex', async (c, { cwd, ids }) => {
  const attributes = { ...ids, stashIndex: c.req.param('stashIndex') ?? '' };
  const result = await traced(c, 'git.stash_show', attributes, () => stashShow(cwd, stashRefOf(c)));
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ files: result.value });
});

// GET /api/git/(project/:projectId | :threadId)/stash/:stashIndex/diff?path=...
onBothCheckouts(stashRoutes, 'GET', '/stash/:stashIndex/diff', async (c, { cwd, ids }) => {
  const filePath = c.req.query('path');
  if (!filePath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const attributes = { ...ids, stashIndex: c.req.param('stashIndex') ?? '', path: filePath };
  const result = await traced(c, 'git.stash_diff', attributes, () =>
    stashFileDiff(cwd, stashRefOf(c), filePath),
  );
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});

// ── Project checkout (/project/:projectId) ──────────────────────────────────

// POST /api/git/project/:projectId/stash
stashRoutes.post('/project/:projectId/stash', (c) =>
  projectGitMutation(c, {
    body: stashSchema,
    paths: stashedFiles,
    run: ({ cwd }, body) => {
      const files = stashedFiles(body);
      return files.length > 0 ? stashFiles(cwd, files) : stash(cwd);
    },
  }),
);

// POST /api/git/project/:projectId/stash/pop
stashRoutes.post('/project/:projectId/stash/pop', (c) =>
  projectGitMutation(c, { run: ({ cwd }) => stashPop(cwd) }),
);

// POST /api/git/project/:projectId/stash/drop/:stashIndex
stashRoutes.post('/project/:projectId/stash/drop/:stashIndex', (c) =>
  projectGitMutation(c, {
    run: async (target) => {
      const index = stashIndexOf(c);
      if (index.isErr()) return err(index.error);
      return stashDropTracked(target, index.value, () =>
        stashDrop(target.cwd, `stash@{${index.value}}`),
      );
    },
  }),
);

// ── Thread checkout (/:threadId) ────────────────────────────────────────────

// POST /api/git/:threadId/stash
stashRoutes.post('/:threadId/stash', (c) =>
  threadGitMutation(c, {
    body: stashSchema,
    paths: stashedFiles,
    run: ({ threadId, userId, cwd }, body) => {
      const files = stashedFiles(body);
      return files.length > 0
        ? gitServiceStashFiles(threadId, userId, cwd, files)
        : gitServiceStash(threadId, userId, cwd);
    },
  }),
);

// POST /api/git/:threadId/stash/pop
stashRoutes.post('/:threadId/stash/pop', (c) =>
  threadGitMutation(c, {
    run: ({ threadId, userId, cwd }) => gitServicePopStash(threadId, userId, cwd),
  }),
);

// POST /api/git/:threadId/stash/drop/:stashIndex
stashRoutes.post('/:threadId/stash/drop/:stashIndex', (c) =>
  threadGitMutation(c, {
    run: async ({ threadId, userId, cwd }) => {
      const index = stashIndexOf(c);
      if (index.isErr()) return err(index.error);
      return stashDropTracked(await threadTarget(userId, threadId, cwd), index.value, () =>
        gitServiceDropStash(threadId, userId, cwd, index.value),
      );
    },
  }),
);
