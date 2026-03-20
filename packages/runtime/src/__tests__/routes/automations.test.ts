import { Hono } from 'hono';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import type { HonoEnv } from '../../types/hono-env.js';

// Mock data
const mockAutomation = {
  id: 'auto-1',
  projectId: 'p1',
  userId: 'user-1',
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

const mockGetAutomation = vi.fn();
const mockTriggerAutomationRun = vi.fn();

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    automations: {
      getAutomation: (...args: any[]) => mockGetAutomation(...args),
    },
  }),
}));

vi.mock('../../services/automation-scheduler.js', () => ({
  triggerAutomationRun: (...args: any[]) => mockTriggerAutomationRun(...args),
}));

import { automationRoutes } from '../../routes/automations.js';

describe('Automation Routes', () => {
  let app: Hono<HonoEnv>;

  beforeEach(() => {
    mockGetAutomation.mockReset();
    mockTriggerAutomationRun.mockReset();

    mockGetAutomation.mockImplementation((id: string) => (id === 'auto-1' ? mockAutomation : null));

    app = new Hono<HonoEnv>();
    // Set userId middleware
    app.use('*', async (c, next) => {
      c.set('userId', 'user-1');
      return next();
    });
    app.route('/automations', automationRoutes);
  });

  test('POST /automations/:id/trigger triggers automation', async () => {
    const res = await app.request('/automations/auto-1/trigger', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockGetAutomation).toHaveBeenCalledWith('auto-1');
    expect(mockTriggerAutomationRun).toHaveBeenCalledWith(mockAutomation);
  });

  test('POST /automations/:id/trigger returns 404 for nonexistent', async () => {
    const res = await app.request('/automations/nonexistent/trigger', { method: 'POST' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('Automation not found');
  });
});
