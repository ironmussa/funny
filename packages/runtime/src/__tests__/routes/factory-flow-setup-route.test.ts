import { afterAll, beforeEach, describe, expect, mock, test, vi } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';
import { ok } from 'neverthrow';

const mocks = (() => ({
  requireThread: vi.fn(),
  requireProject: vi.fn(),
  detectTestStack: vi.fn(),
  startFlowSetupVerifyJob: vi.fn(),
  getFlowSetupVerifyJob: vi.fn(),
  cancelFlowSetupVerifyJob: vi.fn(),
  commitAndPushSetup: vi.fn(),
  pushSetupBranchAndOpenPR: vi.fn(),
  resolveGithubToken: vi.fn(),
}))();

mock.module('../../utils/route-helpers.js', () => ({
  requireThread: mocks.requireThread,
  requireProject: mocks.requireProject,
}));
mock.module('@funny/core', () => ({
  detectTestStack: mocks.detectTestStack,
}));
mock.module('../../services/factory-flow-setup-verify.js', () => ({
  startFlowSetupVerifyJob: mocks.startFlowSetupVerifyJob,
  getFlowSetupVerifyJob: mocks.getFlowSetupVerifyJob,
  cancelFlowSetupVerifyJob: mocks.cancelFlowSetupVerifyJob,
}));
mock.module('../../services/factory-flow-setup-git.js', () => ({
  commitAndPushSetup: mocks.commitAndPushSetup,
  pushSetupBranchAndOpenPR: mocks.pushSetupBranchAndOpenPR,
}));
mock.module('../../routes/github/helpers.js', () => ({
  resolveGithubToken: mocks.resolveGithubToken,
}));

const { factoryFlowSetupRoutes } = await import('../../routes/factory-flow-setup.js');
import type { HonoEnv } from '../../types/hono-env.js';

function makeApp() {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    c.set('organizationId', null);
    await next();
  });
  app.route('/api/threads', factoryFlowSetupRoutes);
  return app;
}

const fakeWorktree = mkdtempSync(join(tmpdir(), 'funny-setup-route-'));
writeFileSync(join(fakeWorktree, '.git'), 'gitdir: /repo/.git/worktrees/s1\n');
afterAll(() => {
  rmSync(fakeWorktree, { recursive: true, force: true });
});

const SETUP_THREAD = {
  id: 't-setup',
  projectId: 'p-1',
  mode: 'worktree',
  source: 'factory-setup',
  worktreePath: fakeWorktree,
  branch: 'funny/factory-setup/s1',
};

describe('factoryFlowSetupRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireThread.mockResolvedValue(ok(SETUP_THREAD));
    mocks.requireProject.mockResolvedValue(ok({ id: 'p-1', path: '/repo' }));
    mocks.resolveGithubToken.mockResolvedValue({ token: 'ghp_123' });
  });

  test('refuses threads whose role (source) is not factory-setup across endpoints', async () => {
    mocks.requireThread.mockResolvedValue(ok({ ...SETUP_THREAD, source: 'web' }));
    const app = makeApp();

    for (const [method, path] of [
      ['POST', '/api/threads/t-1/factory-flow-setup/detect'],
      ['POST', '/api/threads/t-1/factory-flow-setup/verify'],
      ['GET', '/api/threads/t-1/factory-flow-setup/verify/job-1'],
      ['DELETE', '/api/threads/t-1/factory-flow-setup/verify/job-1'],
      ['POST', '/api/threads/t-1/factory-flow-setup/commit'],
      ['POST', '/api/threads/t-1/factory-flow-setup/pull-request'],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe('wrong-thread-role');
    }
  });

  test('POST detect returns detected stack facts', async () => {
    mocks.detectTestStack.mockResolvedValue(
      ok({
        recognized: true,
        packageManager: 'pnpm',
        workspaceTool: 'nx',
        packages: [],
        infraFiles: [],
      }),
    );

    const res = await makeApp().request('/api/threads/t-setup/factory-flow-setup/detect', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      recognized: true,
      packageManager: 'pnpm',
      workspaceTool: 'nx',
      packages: [],
      infraFiles: [],
    });
    expect(mocks.detectTestStack).toHaveBeenCalledWith(fakeWorktree);
  });

  test('verify start, poll, and cancel delegate to verify service', async () => {
    mocks.startFlowSetupVerifyJob.mockReturnValue({ id: 'job-1', state: 'running' });
    mocks.getFlowSetupVerifyJob.mockReturnValue({
      id: 'job-1',
      state: 'done',
      result: { ok: true, verdicts: [], prunedYaml: 'yaml', acceptedCount: 1, rejectedCount: 0 },
    });
    mocks.cancelFlowSetupVerifyJob.mockReturnValue(true);

    const app = makeApp();
    const startRes = await app.request('/api/threads/t-setup/factory-flow-setup/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseSha: 'abc1234',
        workflowYaml: 'name: test',
        rules: [{ globs: ['**/*.spec.ts'], command: 'jest {{files}}' }],
        canaries: [
          {
            ruleIndex: 0,
            passingPath: 'a.spec.ts',
            failingPath: 'b.spec.ts',
          },
        ],
      }),
    });
    expect(startRes.status).toBe(200);
    expect(await startRes.json()).toEqual({ jobId: 'job-1', state: 'running' });

    const pollRes = await app.request('/api/threads/t-setup/factory-flow-setup/verify/job-1');
    expect(pollRes.status).toBe(200);
    expect(await pollRes.json()).toEqual({
      state: 'done',
      result: { ok: true, verdicts: [], prunedYaml: 'yaml', acceptedCount: 1, rejectedCount: 0 },
    });

    const delRes = await app.request('/api/threads/t-setup/factory-flow-setup/verify/job-1', {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ state: 'cancelled' });
  });

  test('POST commit and pull-request delegate to setup git service', async () => {
    mocks.commitAndPushSetup.mockResolvedValue({ ok: true, commitSha: '1234abcd' });
    mocks.pushSetupBranchAndOpenPR.mockResolvedValue({
      ok: true,
      prUrl: 'https://github.com/acme/repo/pull/7',
      prNumber: 7,
    });

    const app = makeApp();
    const commitRes = await app.request('/api/threads/t-setup/factory-flow-setup/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultBranch: 'main',
        files: [{ path: '.funny/workflows/issue-to-merge.yaml', content: 'name: x' }],
        expectedFlowSha: 'a'.repeat(64),
        commitMessage: 'chore: setup',
      }),
    });
    expect(commitRes.status).toBe(200);
    expect(await commitRes.json()).toEqual({ ok: true, commitSha: '1234abcd' });

    const prRes = await app.request('/api/threads/t-setup/factory-flow-setup/pull-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultBranch: 'main',
        title: 'Configure regression proof',
        body: 'Summary',
      }),
    });
    expect(prRes.status).toBe(200);
    expect(await prRes.json()).toEqual({
      ok: true,
      prUrl: 'https://github.com/acme/repo/pull/7',
      prNumber: 7,
    });
    expect(mocks.pushSetupBranchAndOpenPR).toHaveBeenCalledWith(
      expect.objectContaining({
        setupBranch: 'funny/factory-setup/s1',
        githubToken: 'ghp_123',
      }),
    );
  });
});
