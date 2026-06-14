import { badRequest } from '@funny/shared/errors';
import { Hono } from 'hono';
import { errAsync, okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getThread: vi.fn(),
  listThreads: vi.fn(),
  getProject: vi.fn(),
  isProjectInOrg: vi.fn(),
  resolveProjectPath: vi.fn(),
  stageFiles: vi.fn(),
  gitServiceStage: vi.fn(),
  getDiff: vi.fn(),
  getDiffSummary: vi.fn(),
  getStatusSummary: vi.fn(),
  commit: vi.fn(),
  gitRead: vi.fn(),
  push: vi.fn(),
  pull: vi.fn(),
  fetchRemote: vi.fn(),
  getRemoteUrl: vi.fn(),
  gitServicePush: vi.fn(),
  gitServicePull: vi.fn(),
  setOrigin: vi.fn(),
  publishRepo: vi.fn(),
  listGitHubOrgs: vi.fn(),
  gitServiceMerge: vi.fn(),
  gitServiceCreatePR: vi.fn(),
  executeWorkflow: vi.fn(),
  isWorkflowActive: vi.fn(),
  getLog: vi.fn(),
  getGraphLog: vi.fn(),
  getUnpushedHashes: vi.fn(),
  stashList: vi.fn(),
  stash: vi.fn(),
  stashShow: vi.fn(),
  stashFileDiff: vi.fn(),
  gitServiceStash: vi.fn(),
  gitServicePopStash: vi.fn(),
  gitServiceDropStash: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => true) };
});

vi.mock('../../services/thread-manager.js', () => ({
  getThread: mocks.getThread,
  listThreads: mocks.listThreads,
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: {
      getProject: mocks.getProject,
      isProjectInOrg: mocks.isProjectInOrg,
      resolveProjectPath: mocks.resolveProjectPath,
    },
  }),
}));

vi.mock('@funny/core/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@funny/core/git')>();
  return {
    ...actual,
    stageFiles: mocks.stageFiles,
    unstageFiles: vi.fn(),
    invalidateStatusCache: vi.fn(),
    getDiff: mocks.getDiff,
    getDiffSummary: mocks.getDiffSummary,
    getStatusSummary: mocks.getStatusSummary,
    commit: mocks.commit,
    gitRead: mocks.gitRead,
    push: mocks.push,
    pull: mocks.pull,
    fetchRemote: mocks.fetchRemote,
    getRemoteUrl: mocks.getRemoteUrl,
    setOrigin: mocks.setOrigin,
    publishRepo: mocks.publishRepo,
    listGitHubOrgs: mocks.listGitHubOrgs,
    deriveGitSyncState: vi.fn(() => 'synced'),
    getLog: mocks.getLog,
    getGraphLog: mocks.getGraphLog,
    getUnpushedHashes: mocks.getUnpushedHashes,
    stashList: mocks.stashList,
    stash: mocks.stash,
    stashShow: mocks.stashShow,
    stashFileDiff: mocks.stashFileDiff,
  };
});

vi.mock('../../routes/git/helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/git/helpers.js')>();
  return {
    ...actual,
    scheduleBackgroundFetch: vi.fn(),
    schedulePRLookup: vi.fn(),
    emitPRUpdateForThread: vi.fn(),
  };
});

vi.mock('../../services/git-workflow-service.js', () => ({
  executeWorkflow: mocks.executeWorkflow,
  isWorkflowActive: mocks.isWorkflowActive,
}));

vi.mock('../../services/git-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/git-service.js')>();
  return {
    ...actual,
    stage: mocks.gitServiceStage,
    pushChanges: mocks.gitServicePush,
    pullChanges: mocks.gitServicePull,
    merge: mocks.gitServiceMerge,
    createPullRequest: mocks.gitServiceCreatePR,
    stashChanges: mocks.gitServiceStash,
    popStash: mocks.gitServicePopStash,
    dropStash: mocks.gitServiceDropStash,
    resolveIdentity: vi.fn(async () => undefined),
  };
});

vi.mock('../../lib/telemetry.js', () => ({
  metric: vi.fn(),
  startSpan: vi.fn(() => ({ end: vi.fn() })),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { gitRoutes } from '../../routes/git.js';
import { resolveIdentity } from '../../services/git-service.js';

function makeApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    c.set('organizationId', null);
    return next();
  });
  app.route('/api/git', gitRoutes);
  return app;
}

describe('gitRoutes (mounted)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stageFiles.mockReturnValue(okAsync(undefined));
    mocks.gitServiceStage.mockReturnValue(okAsync(undefined));
    mocks.getDiff.mockReturnValue(okAsync({ files: [], summary: { additions: 0, deletions: 0 } }));
    mocks.getDiffSummary.mockReturnValue(okAsync({ files: [], truncated: false }));
    mocks.getStatusSummary.mockReturnValue(
      okAsync({
        branch: 'main',
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 1,
        untracked: 0,
      }),
    );
    mocks.commit.mockReturnValue(okAsync('committed'));
    mocks.gitRead.mockResolvedValue({ exitCode: 0, stdout: 'abc123def\n' });
    mocks.push.mockReturnValue(okAsync('pushed to origin'));
    mocks.pull.mockReturnValue(okAsync('already up to date'));
    mocks.fetchRemote.mockReturnValue(okAsync(undefined));
    mocks.getRemoteUrl.mockReturnValue(okAsync('https://github.com/org/repo.git'));
    mocks.gitServicePush.mockReturnValue(okAsync('thread push ok'));
    mocks.gitServicePull.mockReturnValue(okAsync('thread pull ok'));
    mocks.setOrigin.mockReturnValue(okAsync(undefined));
    mocks.publishRepo.mockReturnValue(okAsync('https://github.com/acme/new-repo.git'));
    mocks.listGitHubOrgs.mockReturnValue(okAsync([{ login: 'acme' }]));
    mocks.gitServiceMerge.mockReturnValue(okAsync('merged into main'));
    mocks.gitServiceCreatePR.mockReturnValue(okAsync('https://github.com/acme/repo/pull/42'));
    mocks.executeWorkflow.mockReturnValue({ workflowId: 'wf-test-1' });
    mocks.isWorkflowActive.mockReturnValue(false);
    mocks.getLog.mockReturnValue(
      okAsync([
        { hash: 'abc111', message: 'init', author: 'a', date: '2026-01-01' },
        { hash: 'def222', message: 'feat', author: 'b', date: '2026-01-02' },
      ]),
    );
    mocks.getGraphLog.mockReturnValue(
      okAsync([
        {
          hash: 'abc111',
          shortHash: 'abc',
          author: 'a',
          authorEmail: 'a@x',
          relativeDate: '1d',
          message: 'init',
          body: '',
          parentHashes: [],
          refs: ['main'],
          headBranch: 'main',
        },
        {
          hash: 'def222',
          shortHash: 'def',
          author: 'b',
          authorEmail: 'b@x',
          relativeDate: '2d',
          message: 'feat',
          body: '',
          parentHashes: ['abc111'],
          refs: [],
          headBranch: null,
        },
      ]),
    );
    mocks.getUnpushedHashes.mockReturnValue(okAsync(new Set(['def222'])));
    mocks.stashList.mockReturnValue(okAsync([{ index: 0, message: 'wip' }]));
    mocks.stash.mockReturnValue(okAsync('Saved working directory'));
    mocks.stashShow.mockReturnValue(okAsync([{ path: 'src/a.ts', status: 'modified' }]));
    mocks.stashFileDiff.mockReturnValue(okAsync('diff --git a/src/a.ts'));
    mocks.gitServiceStash.mockReturnValue(okAsync('thread stash saved'));
    mocks.gitServicePopStash.mockReturnValue(okAsync('popped stash@{0}'));
    mocks.gitServiceDropStash.mockReturnValue(okAsync('dropped stash@{0}'));
    vi.mocked(resolveIdentity).mockResolvedValue(undefined);
    mocks.listThreads.mockResolvedValue({ threads: [] });
    mocks.isProjectInOrg.mockResolvedValue(false);
    mocks.resolveProjectPath.mockReturnValue(errAsync(badRequest('no collaborator path')));
    mocks.getProject.mockResolvedValue({
      id: 'p1',
      userId: 'user-1',
      path: '/tmp/repo',
    });
  });

  test('scratch guard returns 400 for scratch threads (threadId query)', async () => {
    mocks.getThread.mockResolvedValue({ id: 't-scratch', isScratch: true, userId: 'user-1' });
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/stage?threadId=t-scratch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['a.ts'] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('git-not-allowed-for-scratch');
    expect(mocks.stageFiles).not.toHaveBeenCalled();
  });

  test('POST /api/git/project/:projectId/stage stages files for owned project', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['src/a.ts'] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.stageFiles).toHaveBeenCalledWith('/tmp/repo', ['src/a.ts']);
  });

  test('POST /api/git/project/:projectId/stage rejects foreign project', async () => {
    mocks.getProject.mockResolvedValue({ id: 'p1', userId: 'other-user', path: '/tmp/repo' });
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['a.ts'] }),
    });

    expect(res.status).toBe(403);
    expect(mocks.stageFiles).not.toHaveBeenCalled();
  });

  test('POST /api/git/:threadId/stage uses thread cwd', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['b.ts'] }),
    });

    expect(res.status).toBe(200);
    expect(mocks.gitServiceStage).toHaveBeenCalledWith('t1', 'user-1', '/wt/thread', ['b.ts']);
  });

  test('GET /api/git/:threadId/diff returns diff payload', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/diff');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [], summary: { additions: 0, deletions: 0 } });
    expect(mocks.getDiff).toHaveBeenCalledWith('/wt/thread');
  });

  test('GET /api/git/project/:projectId/diff/summary returns summary', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/diff/summary');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ files: [], truncated: false });
    expect(mocks.getDiffSummary).toHaveBeenCalledWith('/tmp/repo', {
      excludePatterns: undefined,
      maxFiles: undefined,
    });
  });

  test('GET /api/git/project/:projectId/status returns sync summary', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('synced');
    expect(body.branch).toBe('main');
    expect(mocks.getStatusSummary).toHaveBeenCalledWith('/tmp/repo');
  });

  test('GET /api/git/status?projectId= aggregates thread statuses', async () => {
    mocks.listThreads.mockResolvedValue({
      threads: [
        {
          id: 't-wt',
          mode: 'worktree',
          worktreePath: '/wt/a',
          branch: 'feat/a',
          mergedAt: null,
          baseBranch: null,
        },
      ],
    });
    const app = makeApp();

    const res = await app.request('/api/git/status?projectId=p1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statuses).toBeDefined();
    expect(mocks.listThreads).toHaveBeenCalledWith({
      projectId: 'p1',
      userId: 'user-1',
      isScratch: 'exclude',
    });
  });

  test('GET /api/git/status without projectId returns 400', async () => {
    const app = makeApp();
    const res = await app.request('/api/git/status');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/projectId required/);
  });

  test('POST /api/git/project/:projectId/commit commits with message', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'feat: tests', amend: false, noVerify: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.output).toBe('committed');
    expect(body.sha).toBe('abc123def');
    expect(mocks.commit).toHaveBeenCalledWith('/tmp/repo', 'feat: tests', undefined, false, true);
  });

  test('POST /api/git/project/:projectId/commit rejects missing message', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  test('POST /api/git/project/:projectId/push pushes to remote', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/push', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, output: 'pushed to origin' });
    expect(mocks.push).toHaveBeenCalledWith('/tmp/repo', undefined);
  });

  test('POST /api/git/project/:projectId/pull pulls with strategy', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'rebase' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, output: 'already up to date' });
    expect(mocks.pull).toHaveBeenCalledWith('/tmp/repo', 'rebase', undefined);
  });

  test('POST /api/git/project/:projectId/fetch fetches remote refs', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/fetch', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.fetchRemote).toHaveBeenCalledWith('/tmp/repo', undefined);
  });

  test('GET /api/git/project/:projectId/remote-url returns origin URL', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/remote-url');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ remoteUrl: 'https://github.com/org/repo.git' });
  });

  test('GET /api/git/project/:projectId/gh-orgs returns empty without GitHub token', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/gh-orgs');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgs: [] });
  });

  test('POST /api/git/:threadId/push uses git-service pushChanges', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/push', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, output: 'thread push ok' });
    expect(mocks.gitServicePush).toHaveBeenCalledWith('t1', 'user-1', '/wt/thread');
  });

  test('POST /api/git/:threadId/pull uses git-service pullChanges', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'merge' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, output: 'thread pull ok' });
    expect(mocks.gitServicePull).toHaveBeenCalledWith('t1', 'user-1', '/wt/thread', 'merge');
  });

  test('POST /api/git/:threadId/fetch fetches for thread cwd', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/fetch', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.fetchRemote).toHaveBeenCalledWith('/wt/thread', undefined);
  });

  test('POST /api/git/project/:projectId/remote sets origin URL', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/acme/repo.git' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.setOrigin).toHaveBeenCalledWith('/tmp/repo', 'https://github.com/acme/repo.git');
  });

  test('POST /api/git/project/:projectId/remote rejects invalid URL', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not-a-valid-remote' }),
    });

    expect(res.status).toBe(400);
    expect(mocks.setOrigin).not.toHaveBeenCalled();
  });

  test('POST /api/git/project/:projectId/publish requires GitHub token', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new-repo', private: true }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/GitHub token required/);
    expect(mocks.publishRepo).not.toHaveBeenCalled();
  });

  test('POST /api/git/project/:projectId/publish creates GitHub repo', async () => {
    vi.mocked(resolveIdentity).mockResolvedValueOnce({ githubToken: 'ghp_publish' });
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new-repo', org: 'acme', private: false }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      repoUrl: 'https://github.com/acme/new-repo.git',
    });
    expect(mocks.publishRepo).toHaveBeenCalledWith(
      '/tmp/repo',
      { name: 'new-repo', org: 'acme', private: false },
      { GH_TOKEN: 'ghp_publish' },
    );
  });

  test('GET /api/git/project/:projectId/gh-orgs lists orgs when token present', async () => {
    vi.mocked(resolveIdentity).mockResolvedValueOnce({ githubToken: 'ghp_orgs' });
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/gh-orgs');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orgs: [{ login: 'acme' }] });
    expect(mocks.listGitHubOrgs).toHaveBeenCalledWith('/tmp/repo', { GH_TOKEN: 'ghp_orgs' });
  });

  test('POST /api/git/:threadId/merge returns error when merge fails', async () => {
    mocks.gitServiceMerge.mockReturnValueOnce(errAsync(badRequest('merge conflict')));
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
      branch: 'feat/merge',
      baseBranch: 'main',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetBranch: 'main', push: false, cleanup: false }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('merge conflict');
  });

  test('POST /api/git/:threadId/pr returns error when PR creation fails', async () => {
    mocks.gitServiceCreatePR.mockReturnValueOnce(errAsync(badRequest('no github token')));
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
      branch: 'feat/pr',
      baseBranch: 'main',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/pr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'PR', body: '' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('no github token');
  });

  test('POST /api/git/:threadId/workflow rejects invalid file paths', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/workflow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'commit',
        message: 'wip',
        filesToStage: ['../../../etc/passwd'],
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Invalid path/);
    expect(mocks.executeWorkflow).not.toHaveBeenCalled();
  });

  test('POST /api/git/:threadId/workflow returns 500 when executeWorkflow throws', async () => {
    mocks.executeWorkflow.mockImplementationOnce(() => {
      throw new Error('workflow engine down');
    });
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/workflow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'push' }),
    });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('workflow engine down');
  });

  test('POST /api/git/:threadId/pr creates pull request', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
      branch: 'feat/pr',
      baseBranch: 'main',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/pr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Add tests', body: 'Coverage for git workflow' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      url: 'https://github.com/acme/repo/pull/42',
    });
    expect(mocks.gitServiceCreatePR).toHaveBeenCalledWith({
      threadId: 't1',
      userId: 'user-1',
      cwd: '/wt/thread',
      title: 'Add tests',
      body: 'Coverage for git workflow',
    });
  });

  test('POST /api/git/:threadId/merge merges feature branch', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
      branch: 'feat/merge',
      baseBranch: 'main',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetBranch: 'main', push: true, cleanup: false }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, output: 'merged into main' });
    expect(mocks.gitServiceMerge).toHaveBeenCalledWith({
      threadId: 't1',
      userId: 'user-1',
      targetBranch: 'main',
      push: true,
      cleanup: false,
    });
  });

  test('POST /api/git/:threadId/workflow starts orchestrated workflow', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
      branch: 'feat/wf',
      baseBranch: 'main',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/workflow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'commit', message: 'wip: tests' }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ workflowId: 'wf-test-1' });
    expect(mocks.executeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: 't1',
        threadId: 't1',
        projectId: 'p1',
        userId: 'user-1',
        cwd: '/wt/thread',
        action: 'commit',
      }),
    );
  });

  test('POST /api/git/:threadId/workflow returns 409 when workflow already active', async () => {
    mocks.isWorkflowActive.mockReturnValueOnce(true);
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/workflow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'push' }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already in progress/);
    expect(mocks.executeWorkflow).not.toHaveBeenCalled();
  });

  test('POST /api/git/project/:projectId/workflow rejects merge action', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/workflow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'merge' }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/requires a thread/);
  });

  test('GET /api/git/:threadId/log scopes to baseBranch by default', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
      baseBranch: 'develop',
    });
    mocks.getUnpushedHashes.mockReturnValueOnce(okAsync(new Set(['def222'])));
    const app = makeApp();

    const res = await app.request('/api/git/t1/log?limit=1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [{ hash: 'abc111', message: 'init', author: 'a', date: '2026-01-01' }],
      hasMore: true,
      unpushedHashes: [],
    });
    expect(mocks.getLog).toHaveBeenCalledWith('/wt/thread', 2, 'develop', 0);
  });

  test('GET /api/git/:threadId/log with all=true omits baseBranch filter', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
      baseBranch: 'develop',
    });
    const app = makeApp();

    await app.request('/api/git/t1/log?all=true');
    expect(mocks.getLog).toHaveBeenCalledWith('/wt/thread', 51, undefined, 0);
  });

  test('GET /api/git/:threadId/log returns error when git log fails', async () => {
    mocks.getLog.mockReturnValueOnce(errAsync(badRequest('not a git repo')));
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
      baseBranch: 'main',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/log');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('not a git repo');
  });

  test('GET /api/git/project/:projectId/log returns paginated entries', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/log?limit=1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [{ hash: 'abc111', message: 'init', author: 'a', date: '2026-01-01' }],
      hasMore: true,
      unpushedHashes: [],
    });
    expect(mocks.getLog).toHaveBeenCalledWith('/tmp/repo', 2, undefined, 0);
    expect(mocks.getUnpushedHashes).toHaveBeenCalledWith('/tmp/repo');
  });

  test('GET /api/git/project/:projectId/log projects unpushed hashes within the window', async () => {
    const app = makeApp();

    // No limit → default 50, so both entries fit and hasMore is false. def222 is
    // in the unpushed set, so it should surface in unpushedHashes.
    const res = await app.request('/api/git/project/p1/log');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [
        { hash: 'abc111', message: 'init', author: 'a', date: '2026-01-01' },
        { hash: 'def222', message: 'feat', author: 'b', date: '2026-01-02' },
      ],
      hasMore: false,
      unpushedHashes: ['def222'],
    });
    expect(mocks.getLog).toHaveBeenCalledWith('/tmp/repo', 51, undefined, 0);
  });

  test('GET /api/git/project/:projectId/log degrades to empty unpushedHashes when lookup fails', async () => {
    mocks.getUnpushedHashes.mockReturnValueOnce(errAsync(badRequest('no remotes')));
    const app = makeApp();

    // The unpushed lookup failing must not fail the whole request — the log
    // still returns 200 with an empty unpushedHashes list.
    const res = await app.request('/api/git/project/p1/log');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries.length).toBe(2);
    expect(body.hasMore).toBe(false);
    expect(body.unpushedHashes).toEqual([]);
  });

  test('GET /api/git/project/:projectId/graph-log returns topology + defaults to all refs', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/graph-log?limit=1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasMore).toBe(true);
    expect(body.entries).toEqual([
      {
        hash: 'abc111',
        shortHash: 'abc',
        author: 'a',
        authorEmail: 'a@x',
        relativeDate: '1d',
        message: 'init',
        body: '',
        parentHashes: [],
        refs: ['main'],
        headBranch: 'main',
      },
    ]);
    expect(body.unpushedHashes).toEqual([]);
    expect(mocks.getGraphLog).toHaveBeenCalledWith('/tmp/repo', { limit: 2, skip: 0, all: true });
  });

  test('GET /api/git/project/:projectId/graph-log?all=false opts out of all refs', async () => {
    const app = makeApp();

    await app.request('/api/git/project/p1/graph-log?all=false');
    expect(mocks.getGraphLog).toHaveBeenCalledWith('/tmp/repo', { limit: 51, skip: 0, all: false });
  });

  test('GET /api/git/:threadId/graph-log uses thread cwd and defaults to all refs', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
      baseBranch: 'main',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/graph-log');
    expect(res.status).toBe(200);
    expect(mocks.getGraphLog).toHaveBeenCalledWith('/wt/thread', { limit: 51, skip: 0, all: true });
  });

  test('GET /api/git/:threadId/graph-log returns error when git log fails', async () => {
    mocks.getGraphLog.mockReturnValueOnce(errAsync(badRequest('not a git repo')));
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
      baseBranch: 'main',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/graph-log');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('not a git repo');
  });

  test('GET /api/git/project/:projectId/stash/list returns stash entries', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/stash/list');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [{ index: 0, message: 'wip' }] });
    expect(mocks.stashList).toHaveBeenCalledWith('/tmp/repo');
  });

  test('POST /api/git/project/:projectId/stash saves working tree', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/stash', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, output: 'Saved working directory' });
    expect(mocks.stash).toHaveBeenCalledWith('/tmp/repo');
  });

  test('GET /api/git/project/:projectId/stash/0/diff requires path query', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/stash/0/diff');
    expect(res.status).toBe(400);
    expect(mocks.stashFileDiff).not.toHaveBeenCalled();
  });

  test('GET /api/git/project/:projectId/stash/0/diff returns file diff', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/stash/0/diff?path=src/a.ts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ diff: 'diff --git a/src/a.ts' });
    expect(mocks.stashFileDiff).toHaveBeenCalledWith('/tmp/repo', 'stash@{0}', 'src/a.ts');
  });

  test('POST /api/git/:threadId/stash saves via git-service', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/stash', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, output: 'thread stash saved' });
    expect(mocks.gitServiceStash).toHaveBeenCalledWith('t1', 'user-1', '/wt/thread');
  });

  test('POST /api/git/:threadId/stash/pop applies latest stash', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/stash/pop', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, output: 'popped stash@{0}' });
    expect(mocks.gitServicePopStash).toHaveBeenCalledWith('t1', 'user-1', '/wt/thread');
  });

  test('POST /api/git/:threadId/stash/drop/:stashIndex drops stash entry', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/stash/drop/0', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, output: 'dropped stash@{0}' });
    expect(mocks.gitServiceDropStash).toHaveBeenCalledWith('t1', 'user-1', '/wt/thread', 0);
  });

  test('GET /api/git/:threadId/stash/list returns entries for thread cwd', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/stash/list');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [{ index: 0, message: 'wip' }] });
    expect(mocks.stashList).toHaveBeenCalledWith('/wt/thread');
  });

  test('GET /api/git/:threadId/stash/:stashIndex/diff requires path query', async () => {
    mocks.getThread.mockResolvedValue({
      id: 't1',
      isScratch: false,
      userId: 'user-1',
      projectId: 'p1',
      worktreePath: '/wt/thread',
    });
    const app = makeApp();

    const res = await app.request('/api/git/t1/stash/0/diff');
    expect(res.status).toBe(400);
    expect(mocks.stashFileDiff).not.toHaveBeenCalled();
  });

  test('POST /api/git/project/:projectId/workflow allows commit action', async () => {
    const app = makeApp();

    const res = await app.request('/api/git/project/p1/workflow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'commit', message: 'project scope' }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ workflowId: 'wf-test-1' });
    expect(mocks.executeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: 'p1',
        projectId: 'p1',
        action: 'commit',
      }),
    );
  });
});
