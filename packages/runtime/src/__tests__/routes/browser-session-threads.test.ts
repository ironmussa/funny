import { beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { Hono } from 'hono';

const listThreadsWithSessions = vi.fn((_userId: string): string[] => []);
const heartbeat = vi.fn((_userId: string, _sessionId: string) => {});
mock.module('../../services/browser-session-manager.js', () => ({
  browserSessionManager: { listThreadsWithSessions, heartbeat },
}));

const { browserSessionRoutes } = await import('../../routes/browser-session.js');
import type { HonoEnv } from '../../types/hono-env.js';

function appAs(userId: string) {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  app.route('/api/browser-session', browserSessionRoutes);
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

describe('POST /api/browser-session/command', () => {
  beforeEach(() => heartbeat.mockReset());

  const command = (body: { type: string; data?: string | number | null | { sessionId: string } }) =>
    appAs('user-1').request('/api/browser-session/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('hands an object payload to its command', async () => {
    const res = await command({ type: 'browser-session:heartbeat', data: { sessionId: 's1' } });
    expect(res.status).toBe(202);
    expect(heartbeat).toHaveBeenCalledWith('user-1', 's1');
  });

  test('refuses a command whose payload is not an object', async () => {
    for (const data of [undefined, null, 'heartbeat', 42]) {
      const res = await command({ type: 'browser-session:heartbeat', data });
      expect(res.status).toBe(400);
    }
    expect(heartbeat).not.toHaveBeenCalled();
  });
});
