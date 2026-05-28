import { Hono } from 'hono';
import { okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getThread: vi.fn(),
  isProjectInOrg: vi.fn(),
  createIdleThread: vi.fn(),
  createAndStartThread: vi.fn(),
  sendMessage: vi.fn(),
  stopThread: vi.fn(),
  forkThread: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../lib/telemetry.js', () => ({
  metric: vi.fn(),
  startSpan: vi.fn(() => ({ end: vi.fn() })),
}));

vi.mock('../../middleware/tracing.js', () => ({
  requestSpan: vi.fn(() => ({ end: vi.fn() })),
}));

vi.mock('../../services/thread-manager.js', () => ({
  getThread: mocks.getThread,
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: { isProjectInOrg: mocks.isProjectInOrg },
  }),
}));

vi.mock('../../services/thread-service/create.js', () => ({
  createIdleThread: mocks.createIdleThread,
  createAndStartThread: mocks.createAndStartThread,
}));

vi.mock('../../services/thread-service/messaging.js', () => ({
  sendMessage: mocks.sendMessage,
  stopThread: mocks.stopThread,
  approveToolCall: vi.fn(),
  cancelQueuedMessage: vi.fn(),
  updateQueuedMessage: vi.fn(),
}));

vi.mock('../../services/thread-service/fork.js', () => ({
  forkThread: mocks.forkThread,
}));

vi.mock('../../services/thread-service/upload.js', () => ({
  uploadFile: mocks.uploadFile,
}));

vi.mock('../../services/thread-service/rewind.js', () => ({
  forkAndRewind: vi.fn(),
  rewindCode: vi.fn(),
}));

vi.mock('../../services/thread-service/update.js', () => ({
  convertToWorktree: vi.fn(),
}));

import { threadRoutes } from '../../routes/threads.js';

const baseThread = {
  id: 't1',
  projectId: 'p1',
  userId: 'user-1',
  title: 'Thread',
  status: 'idle',
  mode: 'local',
  model: 'sonnet',
};

function makeApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    c.set('organizationId', null);
    return next();
  });
  app.route('/api/threads', threadRoutes);
  return app;
}

describe('threadRoutes (mounted)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isProjectInOrg.mockResolvedValue(false);
    mocks.getThread.mockResolvedValue(baseThread);
    mocks.createIdleThread.mockResolvedValue(okAsync({ id: 'idle-1', status: 'idle' }));
    mocks.createAndStartThread.mockResolvedValue(
      okAsync({ id: 'new-1', status: 'running', title: 'New thread' }),
    );
    mocks.sendMessage.mockResolvedValue(okAsync({ ok: true, queued: false }));
    mocks.stopThread.mockResolvedValue(okAsync(undefined));
    mocks.forkThread.mockResolvedValue(okAsync({ id: 'fork-1', title: 'Fork' }));
    mocks.uploadFile.mockResolvedValue(okAsync({ path: '/tmp/upload.txt' }));
  });

  test('POST /idle creates an idle thread', async () => {
    const res = await makeApp().request('/api/threads/idle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1', title: 'Draft', mode: 'local' }),
    });
    expect(res.status).toBe(201);
    expect(mocks.createIdleThread).toHaveBeenCalled();
  });

  test('POST / creates and starts a thread', async () => {
    const res = await makeApp().request('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p1',
        model: 'sonnet',
        mode: 'local',
        prompt: 'hello',
      }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).id).toBe('new-1');
  });

  test('POST /:id/message sends a follow-up message', async () => {
    const res = await makeApp().request('/api/threads/t1/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'follow up' }),
    });
    expect(res.status).toBe(200);
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 't1', content: 'follow up' }),
    );
  });

  test('POST /:id/stop stops the agent', async () => {
    const res = await makeApp().request('/api/threads/t1/stop', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(mocks.stopThread).toHaveBeenCalledWith('t1');
  });

  test('POST /:id/fork forks at a message', async () => {
    const res = await makeApp().request('/api/threads/t1/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'm1', title: 'Fork title' }),
    });
    expect(res.status).toBe(201);
    expect(mocks.forkThread).toHaveBeenCalled();
  });

  test('POST /:id/upload writes an attachment', async () => {
    const res = await makeApp().request('/api/threads/t1/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'claude',
        filename: 'note.txt',
        contentBase64: Buffer.from('hi').toString('base64'),
      }),
    });
    expect(res.status).toBe(200);
    expect(mocks.uploadFile).toHaveBeenCalled();
  });

  test('returns 404 when thread belongs to another user', async () => {
    mocks.getThread.mockResolvedValue({ ...baseThread, userId: 'user-2' });

    const res = await makeApp().request('/api/threads/t1/stop', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(mocks.stopThread).not.toHaveBeenCalled();
  });

  test('returns 404 when thread does not exist', async () => {
    mocks.getThread.mockResolvedValue(null);

    const res = await makeApp().request('/api/threads/missing/stop', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
