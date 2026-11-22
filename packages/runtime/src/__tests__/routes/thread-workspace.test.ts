/**
 * DELETE /api/threads/:id/scratch (track-funny-actions, design D8): removes the
 * caller's own scratch directory, never another user's.
 */
import { beforeEach, describe, expect, mock, test, vi } from 'bun:test';

import { Hono } from 'hono';
import { okAsync } from 'neverthrow';

const mocks = (() => ({
  getThread: vi.fn(),
  removeScratchWorkspace: vi.fn(),
}))();

mock.module('../../services/thread-manager.js', () => ({ getThread: mocks.getThread }));
mock.module('../../services/workspace-cleanup.js', () => ({
  removeScratchWorkspace: mocks.removeScratchWorkspace,
}));

const { threadWorkspaceRoutes } = await import('../../routes/thread-workspace.js');
const { scratchPathFor } = await import('../../services/thread-context.js');

function appAs(userId: string) {
  const app = new Hono<any>();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    await next();
  });
  app.route('/threads', threadWorkspaceRoutes);
  return app;
}

describe('DELETE /threads/:id/scratch', () => {
  beforeEach(() => {
    mocks.getThread.mockReset().mockResolvedValue(undefined);
    mocks.removeScratchWorkspace.mockReset().mockReturnValue(okAsync({ effects: [] }));
  });

  test('removes the caller scratch directory of a deleted thread', async () => {
    const res = await appAs('alice').request('/threads/t1/scratch', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(mocks.removeScratchWorkspace).toHaveBeenCalledWith({
      userId: 'alice',
      threadId: 't1',
      scratchPath: scratchPathFor('alice', 't1'),
    });
  });

  test("refuses another user's thread and removes nothing", async () => {
    mocks.getThread.mockResolvedValue({ id: 't1', userId: 'bob', isScratch: true });
    const res = await appAs('alice').request('/threads/t1/scratch', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(mocks.removeScratchWorkspace).not.toHaveBeenCalled();
  });

  test('refuses a thread that is not a scratch thread', async () => {
    mocks.getThread.mockResolvedValue({ id: 't1', userId: 'alice', isScratch: false });
    const res = await appAs('alice').request('/threads/t1/scratch', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(mocks.removeScratchWorkspace).not.toHaveBeenCalled();
  });

  test('refuses a malformed id', async () => {
    const res = await appAs('alice').request('/threads/..%2F..%2Fetc/scratch', {
      method: 'DELETE',
    });
    expect(res.status).not.toBe(200);
    expect(mocks.removeScratchWorkspace).not.toHaveBeenCalled();
  });
});
