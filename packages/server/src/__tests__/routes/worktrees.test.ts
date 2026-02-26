import { describe, test, expect, mock, beforeEach } from 'bun:test';

import { Hono } from 'hono';
import { ok, err } from 'neverthrow';

// Mock dependencies
const mockListWorktrees = mock(() => ok([{ path: '/tmp/wt1', branch: 'feature/x' }]));
const mockCreateWorktree = mock(() => ok('/tmp/wt-new'));
const mockRemoveWorktree = mock(() => ok(undefined));

mock.module('@funny/core/git', () => ({
  listWorktrees: mockListWorktrees,
  createWorktree: mockCreateWorktree,
  removeWorktree: mockRemoveWorktree,
}));

const mockRequireProject = mock(() => ok({ id: 'p1', path: '/tmp/project', name: 'Test' }));
mock.module('../../utils/route-helpers.js', () => ({
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
    mockRequireProject.mockReset();

    mockListWorktrees.mockReturnValue(ok([{ path: '/tmp/wt1', branch: 'feature/x' }]) as any);
    mockCreateWorktree.mockReturnValue(ok('/tmp/wt-new') as any);
    mockRemoveWorktree.mockReturnValue(ok(undefined) as any);
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
});
