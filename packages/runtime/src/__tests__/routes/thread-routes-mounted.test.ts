import { Hono } from 'hono';
import { errAsync, okAsync } from 'neverthrow';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ThreadServiceError } from '../../services/thread-service/helpers.js';
import type { HonoEnv } from '../../types/hono-env.js';

const mocks = vi.hoisted(() => ({
  getThread: vi.fn(),
  updateToolCallOutput: vi.fn(),
  isProjectInOrg: vi.fn(),
  getThreadEvents: vi.fn(),
  listQueue: vi.fn(),
  createIdleThread: vi.fn(),
  createAndStartThread: vi.fn(),
  sendMessage: vi.fn(),
  stopThread: vi.fn(),
  forkThread: vi.fn(),
  uploadFile: vi.fn(),
  rewindCode: vi.fn(),
  forkAndRewind: vi.fn(),
  convertToWorktree: vi.fn(),
  approveToolCall: vi.fn(),
  cancelQueuedMessage: vi.fn(),
  updateQueuedMessage: vi.fn(),
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
  updateToolCallOutput: mocks.updateToolCallOutput,
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: { isProjectInOrg: mocks.isProjectInOrg },
    threadEvents: { getThreadEvents: mocks.getThreadEvents },
    messageQueue: { listQueue: mocks.listQueue },
  }),
}));

vi.mock('../../services/thread-service/create.js', () => ({
  createIdleThread: mocks.createIdleThread,
  createAndStartThread: mocks.createAndStartThread,
}));

vi.mock('../../services/thread-service/messaging.js', () => ({
  sendMessage: mocks.sendMessage,
  stopThread: mocks.stopThread,
  approveToolCall: mocks.approveToolCall,
  cancelQueuedMessage: mocks.cancelQueuedMessage,
  updateQueuedMessage: mocks.updateQueuedMessage,
}));

vi.mock('../../services/thread-service/fork.js', () => ({
  forkThread: mocks.forkThread,
}));

vi.mock('../../services/thread-service/upload.js', () => ({
  uploadFile: mocks.uploadFile,
}));

vi.mock('../../services/thread-service/rewind.js', () => ({
  forkAndRewind: mocks.forkAndRewind,
  rewindCode: mocks.rewindCode,
}));

vi.mock('../../services/thread-service/update.js', () => ({
  convertToWorktree: mocks.convertToWorktree,
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

function makeApp(userId = 'user-1', organizationId: string | null = null) {
  const app = new Hono<HonoEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    c.set('organizationId', organizationId);
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
    mocks.getThreadEvents.mockResolvedValue([{ id: 'ev-1', type: 'status' }]);
    mocks.listQueue.mockResolvedValue({ messages: [], queuedCount: 0 });
    mocks.updateToolCallOutput.mockResolvedValue(undefined);
    mocks.createIdleThread.mockResolvedValue(okAsync({ id: 'idle-1', status: 'idle' }));
    mocks.createAndStartThread.mockResolvedValue(
      okAsync({ id: 'new-1', status: 'running', title: 'New thread' }),
    );
    mocks.sendMessage.mockResolvedValue(okAsync({ ok: true, queued: false }));
    mocks.stopThread.mockResolvedValue(okAsync(undefined));
    mocks.forkThread.mockResolvedValue(okAsync({ id: 'fork-1', title: 'Fork' }));
    mocks.uploadFile.mockResolvedValue(okAsync({ path: '/tmp/upload.txt' }));
    mocks.rewindCode.mockResolvedValue(okAsync({ ok: true }));
    mocks.forkAndRewind.mockResolvedValue(okAsync({ id: 'fork-rewind-1' }));
    mocks.convertToWorktree.mockResolvedValue(okAsync(undefined));
    mocks.approveToolCall.mockResolvedValue(undefined);
    mocks.cancelQueuedMessage.mockResolvedValue(okAsync({ queuedCount: 0 }));
    mocks.updateQueuedMessage.mockResolvedValue(
      okAsync({ queuedCount: 1, queuedMessage: { id: 'q1', content: 'updated' } }),
    );
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

  test('POST /idle returns 400 on invalid body', async () => {
    const res = await makeApp().request('/api/threads/idle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1' }),
    });
    expect(res.status).toBe(400);
    expect(mocks.createIdleThread).not.toHaveBeenCalled();
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

  test('POST / returns service error status from ThreadServiceError', async () => {
    mocks.createAndStartThread.mockResolvedValue(
      errAsync(new ThreadServiceError('project missing', 404)),
    );

    const res = await makeApp().request('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p1',
        mode: 'local',
        prompt: 'hello',
      }),
    });
    expect(res.status).toBe(404);
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

  test('POST /:id/rewind rewinds code in place', async () => {
    const res = await makeApp().request('/api/threads/t1/rewind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'm1' }),
    });
    expect(res.status).toBe(200);
    expect(mocks.rewindCode).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 't1', messageId: 'm1' }),
    );
  });

  test('POST /:id/fork-and-rewind forks then rewinds', async () => {
    const res = await makeApp().request('/api/threads/t1/fork-and-rewind', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'm1', title: 'Rewound fork' }),
    });
    expect(res.status).toBe(201);
    expect(mocks.forkAndRewind).toHaveBeenCalled();
  });

  test('POST /:id/convert-to-worktree converts a local thread', async () => {
    const res = await makeApp().request('/api/threads/t1/convert-to-worktree', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseBranch: 'main' }),
    });
    expect(res.status).toBe(200);
    expect(mocks.convertToWorktree).toHaveBeenCalledWith('t1', 'user-1', 'main');
  });

  test('POST /:id/approve-tool approves a pending tool', async () => {
    const res = await makeApp().request('/api/threads/t1/approve-tool', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'Write', approved: true }),
    });
    expect(res.status).toBe(200);
    expect(mocks.approveToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 't1', toolName: 'Write', approved: true }),
    );
  });

  test('PATCH /:id/tool-calls/:toolCallId persists tool output', async () => {
    const res = await makeApp().request('/api/threads/t1/tool-calls/tc-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ output: 'done' }),
    });
    expect(res.status).toBe(200);
    expect(mocks.updateToolCallOutput).toHaveBeenCalledWith('tc-1', 'done');
  });

  test('PATCH tool-calls returns 400 when output is missing', async () => {
    const res = await makeApp().request('/api/threads/t1/tool-calls/tc-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test('GET /:id/events returns thread events', async () => {
    const res = await makeApp().request('/api/threads/t1/events');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [{ id: 'ev-1', type: 'status' }] });
  });

  test('GET /:id/queue lists queued messages', async () => {
    mocks.listQueue.mockResolvedValue({
      messages: [{ id: 'q1', content: 'wait' }],
      queuedCount: 1,
    });

    const res = await makeApp().request('/api/threads/t1/queue');
    expect(res.status).toBe(200);
    expect((await res.json()).queuedCount).toBe(1);
  });

  test('DELETE /:id/queue/:messageId cancels a queued message', async () => {
    const res = await makeApp().request('/api/threads/t1/queue/q1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(mocks.cancelQueuedMessage).toHaveBeenCalledWith('t1', 'q1');
  });

  test('PATCH /:id/queue/:messageId updates queued content', async () => {
    const res = await makeApp().request('/api/threads/t1/queue/q1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'updated prompt' }),
    });
    expect(res.status).toBe(200);
    expect(mocks.updateQueuedMessage).toHaveBeenCalledWith('t1', 'q1', 'updated prompt');
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

  test('returns 403 when thread belongs to another user', async () => {
    mocks.getThread.mockResolvedValue({ ...baseThread, userId: 'user-2' });

    const res = await makeApp().request('/api/threads/t1/stop', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(mocks.stopThread).not.toHaveBeenCalled();
  });

  test('allows org member when project is shared with organization', async () => {
    mocks.getThread.mockResolvedValue({ ...baseThread, userId: 'user-2' });
    mocks.isProjectInOrg.mockResolvedValue(true);

    const res = await makeApp('user-1', 'org-1').request('/api/threads/t1/stop', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(mocks.stopThread).toHaveBeenCalledWith('t1');
  });

  test('returns 404 when thread does not exist', async () => {
    mocks.getThread.mockResolvedValue(null);

    const res = await makeApp().request('/api/threads/missing/stop', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('POST /:id/message returns 400 on invalid body', async () => {
    const res = await makeApp().request('/api/threads/t1/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  test('POST /:id/message propagates service errors', async () => {
    mocks.sendMessage.mockResolvedValue(errAsync(new ThreadServiceError('agent busy', 409)));

    const res = await makeApp().request('/api/threads/t1/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'follow up' }),
    });
    expect(res.status).toBe(409);
  });

  test('POST / returns friendly error when Claude CLI is missing', async () => {
    mocks.createAndStartThread.mockResolvedValue(
      errAsync(new Error('Could not find the claude CLI binary')),
    );

    const res = await makeApp().request('/api/threads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p1',
        mode: 'local',
        prompt: 'hello',
      }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Claude Code CLI is not installed');
  });

  test('POST /:id/stop returns 500 when stop fails', async () => {
    mocks.stopThread.mockResolvedValue(errAsync(new ThreadServiceError('stop failed', 500)));

    const res = await makeApp().request('/api/threads/t1/stop', { method: 'POST' });
    expect(res.status).toBe(500);
  });

  test('POST /:id/fork returns 400 on invalid body', async () => {
    const res = await makeApp().request('/api/threads/t1/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'no message id' }),
    });
    expect(res.status).toBe(400);
    expect(mocks.forkThread).not.toHaveBeenCalled();
  });
});
