import { okAsync, errAsync } from 'neverthrow';
import { describe, expect, test, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getThread: vi.fn(),
  createAndStartThread: vi.fn(),
}));

vi.mock('../../services/thread-manager.js', () => ({
  getThread: mocks.getThread,
}));

vi.mock('../../services/thread-service/create.js', () => ({
  createAndStartThread: mocks.createAndStartThread,
}));

// Logger is noisy and hits Abbacchio transport — stub it.
vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { spawnThreadForAgent } from '../../services/agent-watch-tool.js';

const PARENT_ID = 'parent-thread-1';
const OWNER = 'user-owner';

beforeEach(() => {
  mocks.getThread.mockReset();
  mocks.createAndStartThread.mockReset();
  mocks.createAndStartThread.mockReturnValue(okAsync({ id: 'child-1' }));
});

describe('spawnThreadForAgent', () => {
  test('defaults to local mode (parent current branch) in the parent project, using the closure userId', async () => {
    mocks.getThread.mockResolvedValue({
      id: PARENT_ID,
      userId: OWNER,
      projectId: 'proj-42',
      isScratch: false,
    });

    const result = await spawnThreadForAgent(PARENT_ID, OWNER, {
      title: 'Subtask A',
      prompt: 'Do the thing',
    });

    expect(result).toEqual({ ok: true, childId: 'child-1', mode: 'local' });
    expect(mocks.createAndStartThread).toHaveBeenCalledTimes(1);
    const params = mocks.createAndStartThread.mock.calls[0][0];
    expect(params.projectId).toBe('proj-42');
    expect(params.userId).toBe(OWNER);
    expect(params.mode).toBe('local');
    expect(params.parentThreadId).toBe(PARENT_ID);
    expect(params.source).toBe('agent-spawn');
  });

  test('uses worktree mode only when explicitly requested', async () => {
    mocks.getThread.mockResolvedValue({
      id: PARENT_ID,
      userId: OWNER,
      projectId: 'proj-42',
      isScratch: false,
    });

    const result = await spawnThreadForAgent(PARENT_ID, OWNER, {
      title: 'Isolated subtask',
      prompt: 'p',
      mode: 'worktree',
    });

    expect(result.ok && result.mode).toBe('worktree');
    expect(mocks.createAndStartThread.mock.calls[0][0].mode).toBe('worktree');
  });

  test('SECURITY: userId comes from the closure, never from the parent row or model', async () => {
    // Even if the DB row somehow names a different owner, the child is created
    // for the caller-supplied (spawn-bound) userId — runner isolation invariant.
    mocks.getThread.mockResolvedValue({
      id: PARENT_ID,
      userId: 'someone-else',
      projectId: 'proj-42',
      isScratch: false,
    });

    await spawnThreadForAgent(PARENT_ID, OWNER, { title: 't', prompt: 'p' });

    const params = mocks.createAndStartThread.mock.calls[0][0];
    expect(params.userId).toBe(OWNER);
  });

  test('forces local mode + isScratch for a scratch parent, ignoring requested worktree mode', async () => {
    mocks.getThread.mockResolvedValue({
      id: PARENT_ID,
      userId: OWNER,
      projectId: '',
      isScratch: true,
    });

    const result = await spawnThreadForAgent(PARENT_ID, OWNER, {
      title: 'scratch child',
      prompt: 'p',
      mode: 'worktree',
    });

    expect(result).toEqual({ ok: true, childId: 'child-1', mode: 'local' });
    const params = mocks.createAndStartThread.mock.calls[0][0];
    expect(params.mode).toBe('local');
    expect(params.isScratch).toBe(true);
    expect(params.projectId).toBeNull();
  });

  test('respects an explicit local mode for a project thread', async () => {
    mocks.getThread.mockResolvedValue({
      id: PARENT_ID,
      userId: OWNER,
      projectId: 'proj-42',
      isScratch: false,
    });

    const result = await spawnThreadForAgent(PARENT_ID, OWNER, {
      title: 't',
      prompt: 'p',
      mode: 'local',
    });

    expect(result.ok && result.mode).toBe('local');
    expect(mocks.createAndStartThread.mock.calls[0][0].mode).toBe('local');
  });

  test('errors when the parent thread is missing', async () => {
    mocks.getThread.mockResolvedValue(undefined);

    const result = await spawnThreadForAgent(PARENT_ID, OWNER, { title: 't', prompt: 'p' });

    expect(result.ok).toBe(false);
    expect(mocks.createAndStartThread).not.toHaveBeenCalled();
  });

  test('errors when a non-scratch parent has no project', async () => {
    mocks.getThread.mockResolvedValue({
      id: PARENT_ID,
      userId: OWNER,
      projectId: '',
      isScratch: false,
    });

    const result = await spawnThreadForAgent(PARENT_ID, OWNER, { title: 't', prompt: 'p' });

    expect(result.ok).toBe(false);
    expect(mocks.createAndStartThread).not.toHaveBeenCalled();
  });

  test('surfaces createAndStartThread failures', async () => {
    mocks.getThread.mockResolvedValue({
      id: PARENT_ID,
      userId: OWNER,
      projectId: 'proj-42',
      isScratch: false,
    });
    mocks.createAndStartThread.mockReturnValue(errAsync({ message: 'boom' }));

    const result = await spawnThreadForAgent(PARENT_ID, OWNER, { title: 't', prompt: 'p' });

    expect(result).toEqual({ ok: false, error: 'boom' });
  });
});
