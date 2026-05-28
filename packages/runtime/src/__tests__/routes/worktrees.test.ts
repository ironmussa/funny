import { Hono } from 'hono';
import { ok, err, okAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const {
  mockListWorktrees,
  mockCreateWorktree,
  mockRemoveWorktree,
  mockGetStatusSummary,
  mockCheckWorktreePathInProject,
} = vi.hoisted(() => ({
  mockListWorktrees: vi.fn(),
  mockCreateWorktree: vi.fn(),
  mockRemoveWorktree: vi.fn(),
  mockGetStatusSummary: vi.fn(),
  mockCheckWorktreePathInProject: vi.fn(),
}));

vi.mock('@funny/core/git', () => ({
  listWorktrees: mockListWorktrees,
  createWorktree: mockCreateWorktree,
  removeWorktree: mockRemoveWorktree,
  pruneOrphanWorktrees: vi.fn().mockReturnValue(okAsync(0)),
  getStatusSummary: mockGetStatusSummary,
  checkWorktreePathInProject: mockCheckWorktreePathInProject,
  previewWorktree: vi.fn(),
  removeBranch: vi.fn().mockReturnValue(okAsync(undefined)),
}));

const { mockRequireProject } = vi.hoisted(() => ({
  mockRequireProject: vi.fn(),
}));

vi.mock('../../utils/route-helpers.js', () => ({
  requireProject: mockRequireProject,
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
    mockRequireProject.mockReset();

    mockListWorktrees.mockReturnValue(ok([{ path: '/tmp/wt1', branch: 'feature/x' }]) as any);
    mockCreateWorktree.mockReturnValue(ok('/tmp/wt-new') as any);
    mockRemoveWorktree.mockReturnValue(okAsync(undefined) as any);
    mockGetStatusSummary.mockReturnValue(
      okAsync({ unpushedCommitCount: 0, dirtyFileCount: 0, hasRemoteBranch: true }) as any,
    );
    mockCheckWorktreePathInProject.mockReturnValue(null); // null = passes containment
    mockRequireProject.mockReturnValue(ok({ id: 'p1', path: '/tmp/project', name: 'Test' }) as any);

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
    mockRequireProject.mockReturnValue(
      err({ type: 'NOT_FOUND', message: 'Project not found' }) as any,
    );
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
    mockRequireProject.mockReturnValue(
      err({ type: 'NOT_FOUND', message: 'Project not found' }) as any,
    );
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

  test('DELETE /worktrees removes a worktree', async () => {
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
  });

  /*
   * Security CR-3 — `removeWorktree` itself enforces containment, but the
   * route's responsibility is to pass `projectResult.value.path` plus the
   * user-supplied path through. The unit test in
   * `packages/core/src/__tests__/worktree.test.ts` covers the underlying
   * function; here we pin the route-level mapping. If the route ever
   * forgets to forward the result error, this test fails.
   */
  test('DELETE /worktrees surfaces a containment error from removeWorktree', async () => {
    mockRemoveWorktree.mockReturnValue(
      err({
        type: 'BAD_REQUEST',
        message: "worktreePath is outside the project's worktree base",
      }) as any,
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

  /*
   * Security ME-1 — `GET /worktrees/status` calls `checkWorktreePathInProject`
   * BEFORE invoking the status helper. A worktreePath outside the project
   * base must short-circuit with 400 and the status helper must not even
   * be called.
   */
  test('GET /worktrees/status rejects worktreePath outside project base', async () => {
    mockCheckWorktreePathInProject.mockReturnValue({
      type: 'BAD_REQUEST',
      message: "worktreePath is outside the project's worktree base",
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
