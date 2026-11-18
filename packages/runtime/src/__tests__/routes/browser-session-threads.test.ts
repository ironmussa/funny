import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const listThreadsWithSessions = vi.fn((_userId: string): string[] => []);
vi.mock('../../services/browser-session-manager.js', () => ({
  browserSessionManager: { listThreadsWithSessions },
}));

const { browserSessionRoutes } = await import('../../routes/browser-session.js');

function appAs(userId: string) {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  app.route('/api/browser-session', browserSessionRoutes as never);
  return app;
}

describe('GET /api/browser-session/threads', () => {
  beforeEach(() => listThreadsWithSessions.mockReset());

  test("lists the caller's threads that hold a live browser session", async () => {
    listThreadsWithSessions.mockReturnValue(['t1', 't2']);
    const res = await appAs('user-1').request('/api/browser-session/threads');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threadIds: ['t1', 't2'] });
    expect(listThreadsWithSessions).toHaveBeenCalledWith('user-1');
  });
});
