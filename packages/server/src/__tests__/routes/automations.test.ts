import { describe, test, expect, mock, beforeEach } from 'bun:test';

import { Hono } from 'hono';

import type { HonoEnv } from '../../types/hono-env.js';

// Mock data
const mockAutomation = {
  id: 'auto-1',
  projectId: 'p1',
  userId: '__local__',
  name: 'Test Automation',
  prompt: 'Run tests',
  schedule: 'daily',
  provider: 'claude',
  model: 'sonnet',
  mode: 'worktree',
  permissionMode: 'autoEdit',
  enabled: 1,
  maxRunHistory: 20,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockListAutomations = mock(() => [mockAutomation]);
const mockGetAutomation = mock((id: string) => (id === 'auto-1' ? mockAutomation : null));
const mockCreateAutomation = mock((data: any) => ({ ...mockAutomation, ...data }));
const mockUpdateAutomation = mock(() => {});
const mockDeleteAutomation = mock(() => {});
const mockListRuns = mock(() => []);
const mockUpdateRun = mock(() => {});
const mockListInboxRuns = mock(() => []);

mock.module('../../services/automation-manager.js', () => ({
  listAutomations: mockListAutomations,
  getAutomation: mockGetAutomation,
  createAutomation: mockCreateAutomation,
  updateAutomation: mockUpdateAutomation,
  deleteAutomation: mockDeleteAutomation,
  listRuns: mockListRuns,
  updateRun: mockUpdateRun,
  listInboxRuns: mockListInboxRuns,
}));

mock.module('../../services/project-manager.js', () => ({
  getProject: (id: string) => (id === 'p1' ? { id: 'p1', name: 'Test', path: '/tmp/test' } : null),
}));

import { automationRoutes } from '../../routes/automations.js';

describe('Automation Routes', () => {
  let app: Hono<HonoEnv>;

  beforeEach(() => {
    mockListAutomations.mockReset();
    mockGetAutomation.mockReset();
    mockCreateAutomation.mockReset();
    mockUpdateAutomation.mockReset();
    mockDeleteAutomation.mockReset();
    mockListRuns.mockReset();
    mockUpdateRun.mockReset();
    mockListInboxRuns.mockReset();

    mockListAutomations.mockReturnValue([mockAutomation]);
    mockGetAutomation.mockImplementation((id: string) => (id === 'auto-1' ? mockAutomation : null));
    mockCreateAutomation.mockImplementation((data: any) => ({ ...mockAutomation, ...data }));
    mockListRuns.mockReturnValue([]);
    mockListInboxRuns.mockReturnValue([]);

    app = new Hono<HonoEnv>();
    // Set userId middleware
    app.use('*', async (c, next) => {
      c.set('userId', '__local__');
      return next();
    });
    app.route('/automations', automationRoutes);
  });

  test('GET /automations returns list', async () => {
    const res = await app.request('/automations');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /automations with projectId filter', async () => {
    const res = await app.request('/automations?projectId=p1');
    expect(res.status).toBe(200);
    expect(mockListAutomations).toHaveBeenCalledWith('p1', '__local__');
  });

  test('GET /automations/:id returns automation', async () => {
    const res = await app.request('/automations/auto-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('auto-1');
  });

  test('GET /automations/:id returns 404 for nonexistent', async () => {
    const res = await app.request('/automations/nonexistent');
    expect(res.status).toBe(404);
  });

  test('DELETE /automations/:id deletes automation', async () => {
    const res = await app.request('/automations/auto-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockDeleteAutomation).toHaveBeenCalledWith('auto-1');
  });

  test('DELETE /automations/:id returns 404 for nonexistent', async () => {
    const res = await app.request('/automations/nonexistent', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  test('GET /automations/:id/runs returns runs list', async () => {
    const res = await app.request('/automations/auto-1/runs');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /automations/inbox returns inbox items', async () => {
    const res = await app.request('/automations/inbox');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
