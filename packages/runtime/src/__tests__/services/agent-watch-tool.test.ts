import { okAsync, errAsync } from 'neverthrow';
import { describe, test, expect, beforeEach, vi } from 'vitest';

// ── Mock the SDK so `tool()` is capturable and we can invoke the handler ──
// The real createSdkMcpServer hides the handlers behind an MCP instance; for a
// unit test we want to call `funny_spawn_thread`'s handler directly. The mock
// keeps the (name, description, schema, handler) shape so the test can find the
// tool by name and call its handler with raw args.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (config: any) => config,
  tool: (name: string, description: string, schema: any, handler: any) => ({
    name,
    description,
    schema,
    handler,
  }),
}));

const { getThread, createAndStartThread } = vi.hoisted(() => ({
  getThread: vi.fn(),
  createAndStartThread: vi.fn(),
}));

vi.mock('../../services/thread-manager.js', () => ({ getThread }));
vi.mock('../../services/thread-service/create.js', () => ({ createAndStartThread }));
vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// These are imported at module load but only used by the other tools; stub them
// so the import graph stays light and isolated.
vi.mock('../../services/agent-job-manager.js', () => ({ spawnJob: vi.fn() }));
vi.mock('../../services/agent-watcher-manager.js', () => ({ createOrReschedule: vi.fn() }));

import { buildWatchMcpServer } from '../../services/agent-watch-tool.js';

const PARENT_THREAD = 'parent-thread-1';
const USER = 'user-abc';

function spawnTool() {
  const server = buildWatchMcpServer(PARENT_THREAD, USER) as any;
  const t = server.tools.find((x: any) => x.name === 'funny_spawn_thread');
  if (!t) throw new Error('funny_spawn_thread tool not registered');
  return t;
}

beforeEach(() => {
  getThread.mockReset();
  createAndStartThread.mockReset();
  createAndStartThread.mockReturnValue(okAsync({ id: 'child-1' }));
});

describe('funny_spawn_thread', () => {
  test('inherits projectId from the parent and userId from the closure — never from args', async () => {
    getThread.mockResolvedValue({ id: PARENT_THREAD, projectId: 'proj-9', isScratch: 0 });

    const res = await spawnTool().handler({ title: 'Subtask', prompt: 'do the thing' });

    expect(getThread).toHaveBeenCalledWith(PARENT_THREAD);
    expect(createAndStartThread).toHaveBeenCalledTimes(1);
    const params = createAndStartThread.mock.calls[0][0];
    // Security boundary: userId comes from the spawn binding, projectId from the
    // parent row — the model cannot redirect a spawn to another user/project.
    expect(params.userId).toBe(USER);
    expect(params.projectId).toBe('proj-9');
    expect(params.parentThreadId).toBe(PARENT_THREAD);
    expect(params.isScratch).toBe(false);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('child-1');
  });

  test('defaults to local mode (parent branch, no new branch) for a normal thread', async () => {
    getThread.mockResolvedValue({ id: PARENT_THREAD, projectId: 'proj-9', isScratch: 0 });

    await spawnTool().handler({ title: 'T', prompt: 'p' });

    expect(createAndStartThread.mock.calls[0][0].mode).toBe('local');
  });

  test('honors mode:"worktree" when explicitly requested on a normal thread', async () => {
    getThread.mockResolvedValue({ id: PARENT_THREAD, projectId: 'proj-9', isScratch: 0 });

    await spawnTool().handler({ title: 'T', prompt: 'p', mode: 'worktree' });

    expect(createAndStartThread.mock.calls[0][0].mode).toBe('worktree');
  });

  test('forces local mode and scratch for a scratch parent (no git/worktree)', async () => {
    getThread.mockResolvedValue({ id: PARENT_THREAD, projectId: null, isScratch: 1 });

    await spawnTool().handler({ title: 'T', prompt: 'p', mode: 'worktree' });

    const params = createAndStartThread.mock.calls[0][0];
    expect(params.mode).toBe('local');
    expect(params.isScratch).toBe(true);
    expect(params.projectId).toBeNull();
  });

  test('errors when the parent thread is missing', async () => {
    getThread.mockResolvedValue(undefined);

    const res = await spawnTool().handler({ title: 'T', prompt: 'p' });

    expect(res.isError).toBe(true);
    expect(createAndStartThread).not.toHaveBeenCalled();
  });

  test('errors when a non-scratch parent has no project', async () => {
    getThread.mockResolvedValue({ id: PARENT_THREAD, projectId: null, isScratch: 0 });

    const res = await spawnTool().handler({ title: 'T', prompt: 'p' });

    expect(res.isError).toBe(true);
    expect(createAndStartThread).not.toHaveBeenCalled();
  });

  test('surfaces a creation failure as a tool error instead of throwing', async () => {
    getThread.mockResolvedValue({ id: PARENT_THREAD, projectId: 'proj-9', isScratch: 0 });
    createAndStartThread.mockReturnValue(errAsync({ message: 'boom' }));

    const res = await spawnTool().handler({ title: 'T', prompt: 'p' });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('boom');
  });
});
