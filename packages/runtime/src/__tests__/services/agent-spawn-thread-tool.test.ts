import { okAsync, errAsync } from 'neverthrow';
import { describe, test, expect, beforeEach, vi } from 'vitest';

// ── Mock dependencies ────────────────────────────────────────────
const { getThread, createAndStartThread } = vi.hoisted(() => ({
  getThread: vi.fn(),
  createAndStartThread: vi.fn(),
}));

vi.mock('../../services/thread-manager.js', () => ({ getThread }));
vi.mock('../../services/thread-service/create.js', () => ({ createAndStartThread }));
vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { spawnThreadForAgent } from '../../services/agent-watch-tool.js';

beforeEach(() => {
  getThread.mockReset();
  createAndStartThread.mockReset();
  createAndStartThread.mockReturnValue(okAsync({ id: 'child-1' }));
});

describe('spawnThreadForAgent — runner-isolation invariant', () => {
  test('takes userId from the closure and projectId from the parent row, not the model', async () => {
    getThread.mockResolvedValue({ id: 'thread-1', userId: 'user-1', projectId: 'proj-1' });

    const result = await spawnThreadForAgent('thread-1', 'user-1', {
      title: 'Subtask',
      prompt: 'do the thing',
    });

    expect(result).toEqual({ ok: true, childId: 'child-1', mode: 'local' });
    expect(createAndStartThread).toHaveBeenCalledTimes(1);
    expect(createAndStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        projectId: 'proj-1',
        parentThreadId: 'thread-1',
        mode: 'local', // default: parent's current branch, no new branch
        source: 'agent-spawn',
        isScratch: false,
        title: 'Subtask',
        prompt: 'do the thing',
      }),
    );
  });

  test('honors an explicit worktree mode for project threads', async () => {
    getThread.mockResolvedValue({ id: 'thread-1', userId: 'user-1', projectId: 'proj-1' });

    await spawnThreadForAgent('thread-1', 'user-1', {
      title: 'T',
      prompt: 'p',
      mode: 'worktree',
    });

    expect(createAndStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'worktree' }),
    );
  });
});

describe('spawnThreadForAgent — scratch parents', () => {
  test('forces local mode + isScratch and a null projectId for a scratch parent', async () => {
    getThread.mockResolvedValue({
      id: 'thread-1',
      userId: 'user-1',
      projectId: '',
      isScratch: true,
    });

    const result = await spawnThreadForAgent('thread-1', 'user-1', {
      title: 'T',
      prompt: 'p',
      mode: 'worktree', // requested worktree, but scratch must stay local
    });

    expect(result).toEqual({ ok: true, childId: 'child-1', mode: 'local' });
    expect(createAndStartThread).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'local', isScratch: true, projectId: null }),
    );
  });
});

describe('spawnThreadForAgent — failure paths', () => {
  test('returns an error and never creates when the parent thread is missing', async () => {
    getThread.mockResolvedValue(null);

    const result = await spawnThreadForAgent('thread-1', 'user-1', { title: 'T', prompt: 'p' });

    expect(result.ok).toBe(false);
    expect(createAndStartThread).not.toHaveBeenCalled();
  });

  test('returns an error for a non-scratch parent with no project', async () => {
    getThread.mockResolvedValue({ id: 'thread-1', userId: 'user-1', projectId: '' });

    const result = await spawnThreadForAgent('thread-1', 'user-1', { title: 'T', prompt: 'p' });

    expect(result.ok).toBe(false);
    expect(createAndStartThread).not.toHaveBeenCalled();
  });

  test('surfaces a createAndStartThread error', async () => {
    getThread.mockResolvedValue({ id: 'thread-1', userId: 'user-1', projectId: 'proj-1' });
    createAndStartThread.mockReturnValue(errAsync({ message: 'boom' }));

    const result = await spawnThreadForAgent('thread-1', 'user-1', { title: 'T', prompt: 'p' });

    expect(result).toEqual({ ok: false, error: 'boom' });
  });
});
