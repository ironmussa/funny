/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import {
  stageFiles,
  unstageFiles,
  stagePatch,
  unstagePatch,
  revertFiles,
  resolveFileConflict,
  resetSoft,
} from '@funny/core/git';
import { Hono } from 'hono';

import { discardTracked, resetHardTracked, threadTarget } from '../../services/git-destructive.js';
import {
  stage as gitServiceStage,
  unstage as gitServiceUnstage,
  revert as gitServiceRevert,
  softReset as gitServiceSoftReset,
  checkoutHash as gitServiceCheckoutHash,
  revertCommit as gitServiceRevertCommit,
  resetHard as gitServiceResetHard,
  cherryPickCommit as gitServiceCherryPick,
  createBranchAt as gitServiceCreateBranch,
} from '../../services/git-service.js';
import type { HonoEnv } from '../../types/hono-env.js';
import {
  stageFilesSchema,
  stagePatchSchema,
  resolveConflictSchema,
  checkoutHashSchema,
  revertCommitSchema,
  resetHardSchema,
  cherryPickSchema,
  createBranchSchema,
} from '../../validation/schemas.js';
import { okOnly, projectGitMutation, threadGitMutation } from './checkout-route.js';

export const stageRoutes = new Hono<HonoEnv>();

const filePaths = (body: { paths: string[] }) => body.paths;
const conflictPath = (body: { filePath: string }) => [body.filePath];
const conflictResult = (value: { remainingConflicts: unknown }) => ({
  remainingConflicts: value.remainingConflicts,
});

// ── Project checkout (/project/:projectId) ──────────────────────────────────

// POST /api/git/project/:projectId/stage
stageRoutes.post('/project/:projectId/stage', (c) =>
  projectGitMutation(c, {
    body: stageFilesSchema,
    paths: filePaths,
    run: ({ cwd }, { paths }) => stageFiles(cwd, paths),
    respond: okOnly,
  }),
);

// POST /api/git/project/:projectId/unstage
stageRoutes.post('/project/:projectId/unstage', (c) =>
  projectGitMutation(c, {
    body: stageFilesSchema,
    paths: filePaths,
    run: ({ cwd }, { paths }) => unstageFiles(cwd, paths),
    respond: okOnly,
  }),
);

// POST /api/git/project/:projectId/stage-patch — partial (line-level) staging
stageRoutes.post('/project/:projectId/stage-patch', (c) =>
  projectGitMutation(c, {
    body: stagePatchSchema,
    run: ({ cwd }, { patch }) => stagePatch(cwd, patch),
    respond: okOnly,
  }),
);

// POST /api/git/project/:projectId/unstage-patch — partial (line-level) unstaging
stageRoutes.post('/project/:projectId/unstage-patch', (c) =>
  projectGitMutation(c, {
    body: stagePatchSchema,
    run: ({ cwd }, { patch }) => unstagePatch(cwd, patch),
    respond: okOnly,
  }),
);

// POST /api/git/project/:projectId/revert
stageRoutes.post('/project/:projectId/revert', (c) =>
  projectGitMutation(c, {
    body: stageFilesSchema,
    paths: filePaths,
    run: (target, { paths }) => discardTracked(target, paths, () => revertFiles(target.cwd, paths)),
    respond: okOnly,
  }),
);

// POST /api/git/project/:projectId/checkout-commit
// Security ME-3: `hash` from the request body is passed positionally to
// `git checkout`. Without a schema, a value like `--force` would be
// interpreted as a flag. `gitRefSchema` rejects leading-`-` and any char
// not valid in a git ref / hash.
stageRoutes.post('/project/:projectId/checkout-commit', (c) =>
  projectGitMutation(c, {
    body: checkoutHashSchema,
    run: ({ projectId, userId, cwd }, { hash }) =>
      gitServiceCheckoutHash(projectId, userId, cwd, hash),
  }),
);

// POST /api/git/project/:projectId/revert-commit
stageRoutes.post('/project/:projectId/revert-commit', (c) =>
  projectGitMutation(c, {
    body: revertCommitSchema,
    run: ({ projectId, userId, cwd }, { hash }) =>
      gitServiceRevertCommit(projectId, userId, cwd, hash),
  }),
);

// POST /api/git/project/:projectId/reset-hard
stageRoutes.post('/project/:projectId/reset-hard', (c) =>
  projectGitMutation(c, {
    body: resetHardSchema,
    run: (target, { hash }) =>
      resetHardTracked(target, hash, () =>
        gitServiceResetHard(target.projectId, target.userId, target.cwd, hash),
      ),
  }),
);

// POST /api/git/project/:projectId/cherry-pick
stageRoutes.post('/project/:projectId/cherry-pick', (c) =>
  projectGitMutation(c, {
    body: cherryPickSchema,
    run: ({ projectId, userId, cwd }, { hash }) =>
      gitServiceCherryPick(projectId, userId, cwd, hash),
  }),
);

// POST /api/git/project/:projectId/create-branch
stageRoutes.post('/project/:projectId/create-branch', (c) =>
  projectGitMutation(c, {
    body: createBranchSchema,
    run: ({ projectId, userId, cwd }, { name, startPoint }) =>
      gitServiceCreateBranch(projectId, userId, cwd, name, startPoint),
  }),
);

// POST /api/git/project/:projectId/conflict/resolve
stageRoutes.post('/project/:projectId/conflict/resolve', (c) =>
  projectGitMutation(c, {
    body: resolveConflictSchema,
    paths: conflictPath,
    run: ({ cwd }, { filePath, blockIndex, resolution }) =>
      resolveFileConflict(cwd, filePath, blockIndex, resolution),
    respond: conflictResult,
  }),
);

// POST /api/git/project/:projectId/reset-soft
stageRoutes.post('/project/:projectId/reset-soft', (c) =>
  projectGitMutation(c, { run: ({ cwd }) => resetSoft(cwd) }),
);

// ── Thread checkout (/:threadId) ────────────────────────────────────────────

// POST /api/git/:threadId/stage
stageRoutes.post('/:threadId/stage', (c) =>
  threadGitMutation(c, {
    body: stageFilesSchema,
    paths: filePaths,
    run: ({ threadId, userId, cwd }, { paths }) => gitServiceStage(threadId, userId, cwd, paths),
    respond: okOnly,
  }),
);

// POST /api/git/:threadId/unstage
stageRoutes.post('/:threadId/unstage', (c) =>
  threadGitMutation(c, {
    body: stageFilesSchema,
    paths: filePaths,
    run: ({ threadId, userId, cwd }, { paths }) => gitServiceUnstage(threadId, userId, cwd, paths),
    respond: okOnly,
  }),
);

// POST /api/git/:threadId/stage-patch — partial (line-level) staging
stageRoutes.post('/:threadId/stage-patch', (c) =>
  threadGitMutation(c, {
    body: stagePatchSchema,
    run: ({ cwd }, { patch }) => stagePatch(cwd, patch),
    respond: okOnly,
  }),
);

// POST /api/git/:threadId/unstage-patch — partial (line-level) unstaging
stageRoutes.post('/:threadId/unstage-patch', (c) =>
  threadGitMutation(c, {
    body: stagePatchSchema,
    run: ({ cwd }, { patch }) => unstagePatch(cwd, patch),
    respond: okOnly,
  }),
);

// POST /api/git/:threadId/revert
stageRoutes.post('/:threadId/revert', (c) =>
  threadGitMutation(c, {
    body: stageFilesSchema,
    paths: filePaths,
    run: async ({ threadId, userId, cwd }, { paths }) =>
      discardTracked(await threadTarget(userId, threadId, cwd), paths, () =>
        gitServiceRevert(threadId, userId, cwd, paths),
      ),
    respond: okOnly,
  }),
);

// POST /api/git/:threadId/conflict/resolve
stageRoutes.post('/:threadId/conflict/resolve', (c) =>
  threadGitMutation(c, {
    body: resolveConflictSchema,
    paths: conflictPath,
    run: ({ cwd }, { filePath, blockIndex, resolution }) =>
      resolveFileConflict(cwd, filePath, blockIndex, resolution),
    respond: conflictResult,
  }),
);

// POST /api/git/:threadId/reset-soft
stageRoutes.post('/:threadId/reset-soft', (c) =>
  threadGitMutation(c, {
    run: ({ threadId, userId, cwd }) => gitServiceSoftReset(threadId, userId, cwd),
  }),
);

// POST /api/git/:threadId/checkout-commit (Security ME-3: see the project route above)
stageRoutes.post('/:threadId/checkout-commit', (c) =>
  threadGitMutation(c, {
    body: checkoutHashSchema,
    run: ({ threadId, userId, cwd }, { hash }) =>
      gitServiceCheckoutHash(threadId, userId, cwd, hash),
  }),
);

// POST /api/git/:threadId/revert-commit
stageRoutes.post('/:threadId/revert-commit', (c) =>
  threadGitMutation(c, {
    body: revertCommitSchema,
    run: ({ threadId, userId, cwd }, { hash }) =>
      gitServiceRevertCommit(threadId, userId, cwd, hash),
  }),
);

// POST /api/git/:threadId/reset-hard
stageRoutes.post('/:threadId/reset-hard', (c) =>
  threadGitMutation(c, {
    body: resetHardSchema,
    run: async ({ threadId, userId, cwd }, { hash }) =>
      resetHardTracked(await threadTarget(userId, threadId, cwd), hash, () =>
        gitServiceResetHard(threadId, userId, cwd, hash),
      ),
  }),
);

// POST /api/git/:threadId/cherry-pick
stageRoutes.post('/:threadId/cherry-pick', (c) =>
  threadGitMutation(c, {
    body: cherryPickSchema,
    run: ({ threadId, userId, cwd }, { hash }) => gitServiceCherryPick(threadId, userId, cwd, hash),
  }),
);

// POST /api/git/:threadId/create-branch
stageRoutes.post('/:threadId/create-branch', (c) =>
  threadGitMutation(c, {
    body: createBranchSchema,
    run: ({ threadId, userId, cwd }, { name, startPoint }) =>
      gitServiceCreateBranch(threadId, userId, cwd, name, startPoint),
  }),
);
