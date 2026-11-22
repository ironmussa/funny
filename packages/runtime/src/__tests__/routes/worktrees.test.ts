import { describe, test, expect, vi, beforeEach, mock } from 'bun:test';

import { Hono } from 'hono';
import { ok, err, errAsync, okAsync } from 'neverthrow';

const {
  mockListWorktrees,
  mockCreateWorktree,
  mockRemoveWorktree,
  mockGetStatusSummary,
  mockCheckWorktreePathInProject,
  mockInvalidateSearch,
} = (() => ({
  mockListWorktrees: vi.fn(),
  mockCreateWorktree: vi.fn(),
  mockRemoveWorktree: vi.fn(),
  mockGetStatusSummary: vi.fn(),
  mockCheckWorktreePathInProject: vi.fn(),
  mockInvalidateSearch: vi.fn(),
}))();

mock.module('@funny/core/git', () => ({
  listWorktrees: mockListWorktrees,
  createWorktree: mockCreateWorktree,
  removeWorktree: mockRemoveWorktree,
  pruneOrphanWorktrees: vi.fn().mockReturnValue(okAsync(0)),
  getStatusSummary: mockGetStatusSummary,
  checkWorktreePathInProject: mockCheckWorktreePathInProject,
  previewWorktree: vi.fn(),
  removeBranch: vi.fn().mockReturnValue(okAsync(undefined)),
}));

const { mockRequireProject } = (() => ({
  mockRequireProject: vi.fn(),
}))();

mock.module('../../utils/route-helpers.js', () => ({
  requireProject: mockRequireProject,
}));

mock.module('../../services/project-search-registry.js', () => ({
  projectSearchRegistry: { invalidate: mockInvalidateSearch },
}));

// Removal goes through the workspace module (track-funny-actions, design D3);
// its own steps are covered by workspace-cleanup.test.ts.
const { mockCleanupWorkspace, mockPruneOrphans } = (() => ({
  mockCleanupWorkspace: vi.fn(),
  mockPruneOrphans: vi.fn(),
}))();

mock.module('../../services/workspace-cleanup.js', () => ({
  cleanupWorkspace: mockCleanupWorkspace,
  pruneOrphans: mockPruneOrphans,
}));

// Import after mocks
import { worktreeRoutes } from '../../routes/worktrees.js';

describe('Worktree Routes', () => {
  let app: Hono;

  beforeEach(() => {
    mockListWorktrees.mockReset();
    mockCreateWorktree.mockReset();
    mockRemoveWorktree.mockReset();
    mockGetStatusSummary.mockReset();
    mockCheckWorktreePathInProject.mockReset();
    mockInvalidateSearch.mockReset();
    mockRequireProject.mockReset();
    mockCleanupWorkspace.mockReset();
    mockPruneOrphans.mockReset();
    mockCleanupWorkspace.mockReturnValue(okAsync({ effects: [] }));
    mockPruneOrphans.mockReturnValue(okAsync(0));

    mockListWorktrees.mockReturnValue(ok([{ path: '/tmp/wt1', branch: 'feature/x' }]));
    mockCreateWorktree.mockReturnValue(ok('/tmp/wt-new'));
    mockRemoveWorktree.mockReturnValue(okAsync(undefined));
    mockGetStatusSummary.mockReturnValue(
      okAsync({ unpushedCommitCount: 0, dirtyFileCount: 0, hasRemoteBranch: true }),
    );
    mockCheckWorktreePathInProject.mockReturnValue(null); // null = passes containment
    mockInvalidateSearch.mockReturnValue(okAsync(false));
    mockRequireProject.mockReturnValue(ok({ id: 'p1', path: '/tmp/project', name: 'Test' }));

    app = new Hono();
    app.route('/worktrees', worktreeRoutes);
  });

  test('GET /worktrees returns 400 without projectId', async () => {
    const res = await app.request('/worktrees');
    expect(res.status).toBe(400);
  });

  test('GET /worktrees returns worktree list', async () => {
    const res = await app.request('/worktrees?projectId=p1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /worktrees returns 404 when project not found', async () => {
    mockRequireProject.mockReturnValue(err({ type: 'NOT_FOUND', message: 'Project not found' }));
    const res = await app.request('/worktrees?projectId=nonexistent');
    expect(res.status).toBe(404);
  });

  test('POST /worktrees creates a worktree', async () => {
    const res = await app.request('/worktrees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p1',
        branchName: 'feature/new',
        baseBranch: 'main',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.path).toBe('/tmp/wt-new');
    expect(body.branch).toBe('feature/new');
  });

  test('POST /worktrees returns 404 when project not found', async () => {
    mockRequireProject.mockReturnValue(err({ type: 'NOT_FOUND', message: 'Project not found' }));
    const res = await app.request('/worktrees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'nonexistent',
        branchName: 'feature/new',
        baseBranch: 'main',
      }),
    });
    expect(res.status).toBe(404);
  });

  test('DELETE /worktrees removes a worktree through the workspace module', async () => {
    const res = await app.request('/worktrees', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p1',
        worktreePath: '/tmp/wt1',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockCleanupWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        projectPath: '/tmp/project',
        worktreePath: '/tmp/wt1',
        deleteBranch: false,
        reason: 'manual',
        threadId: null,
      }),
    );
  });

  test('DELETE /worktrees forwards the reason and thread the server sends', async () => {
    const res = await app.request('/worktrees', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p1',
        worktreePath: '/tmp/wt1',
        branchName: 'feature/x',
        deleteBranch: true,
        reason: 'thread-archived',
        threadId: 't1',
      }),
    });
    expect(res.status).toBe(200);
    expect(mockCleanupWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'feature/x',
        deleteBranch: true,
        reason: 'thread-archived',
        threadId: 't1',
      }),
    );
  });

  test('DELETE /worktrees refuses an unknown reason', async () => {
    const res = await app.request('/worktrees', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1', worktreePath: '/tmp/wt1', reason: 'because' }),
    });
    expect(res.status).toBe(400);
    expect(mockCleanupWorkspace).not.toHaveBeenCalled();
  });

  /*
   * Security CR-3 — the workspace module refuses a path that is not a
   * worktree of the project; the route must forward that error.
   */
  test('DELETE /worktrees surfaces a refused target', async () => {
    mockCleanupWorkspace.mockReturnValue(
      errAsync({
        type: 'BAD_REQUEST',
        message: "worktreePath is not one of the project's worktree directories",
      }),
    );
    const res = await app.request('/worktrees', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p1',
        worktreePath: '/etc',
      }),
    });
    expect(res.status).toBe(400);
  });

  test('GET /worktrees prunes orphans through the workspace module', async () => {
    await app.request('/worktrees?projectId=p1');
    expect(mockPruneOrphans).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', projectPath: '/tmp/project' }),
    );
  });

  /*
   * Security ME-1 — `GET /worktrees/status` calls `checkWorktreePathInProject`
   * BEFORE invoking the status helper. A worktreePath outside the project
   * base must short-circuit with 400 and the status helper must not even
   * be called.
   */
  test('GET /worktrees/status rejects worktreePath outside project base', async () => {
    mockCheckWorktreePathInProject.mockReturnValue({
      type: 'BAD_REQUEST',
      message: "worktreePath is not one of the project's worktree directories",
    });
    const res = await app.request('/worktrees/status?projectId=p1&worktreePath=/etc');
    expect(res.status).toBe(400);
    expect(mockGetStatusSummary).not.toHaveBeenCalled();
  });

  test('GET /worktrees/status passes through when containment check passes', async () => {
    mockCheckWorktreePathInProject.mockReturnValue(null);
    const res = await app.request(
      '/worktrees/status?projectId=p1&worktreePath=/tmp/project/.funny-worktrees/project/feature',
    );
    expect(res.status).toBe(200);
    expect(mockGetStatusSummary).toHaveBeenCalled();
  });
});
