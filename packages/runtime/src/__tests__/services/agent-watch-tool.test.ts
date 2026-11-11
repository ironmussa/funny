import { okAsync, errAsync } from 'neverthrow';
import { describe, test, expect, beforeEach, vi } from 'vitest';

const { getThread, createAndStartThread, remoteSearchThreads } = vi.hoisted(() => ({
  getThread: vi.fn(),
  createAndStartThread: vi.fn(),
  remoteSearchThreads: vi.fn(),
}));

vi.mock('../../services/thread-manager.js', () => ({ getThread }));
vi.mock('../../services/thread-service/create.js', () => ({ createAndStartThread }));
vi.mock('../../services/remote-thread-data-client.js', () => ({ remoteSearchThreads }));
vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// These are imported at module load but only used by the other tools; stub them
// so the import graph stays light and isolated.
vi.mock('../../services/agent-job-manager.js', () => ({ spawnJob: vi.fn() }));
vi.mock('../../services/agent-watcher-manager.js', () => ({ createOrReschedule: vi.fn() }));

import { watchToolDefinitions } from '../../services/agent-watch-tool.js';

const PARENT_THREAD = 'parent-thread-1';
const USER = 'user-abc';

function toolNamed(name: string) {
  const t = watchToolDefinitions({ threadId: PARENT_THREAD, userId: USER }).find(
    (x) => x.name === name,
  );
  if (!t) throw new Error(`${name} tool not registered`);
  return { handler: (args: Record<string, unknown>) => t.run(args, undefined) as Promise<any> };
}

const spawnTool = () => toolNamed('funny_spawn_thread');
const searchTool = () => toolNamed('funny_search_threads');

beforeEach(() => {
  getThread.mockReset();
  createAndStartThread.mockReset();
  remoteSearchThreads.mockReset();
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

describe('funny_search_threads', () => {
  test('errors (without hitting the server) when no filter is provided', async () => {
    const res = await searchTool().handler({});

    expect(res.isError).toBe(true);
    expect(remoteSearchThreads).not.toHaveBeenCalled();
  });

  test('forwards filters and formats matches with thread/role/snippet', async () => {
    remoteSearchThreads.mockResolvedValue([
      {
        threadId: 'th-1',
        threadTitle: 'Pipeline work',
        messageId: 'm-1',
        role: 'user',
        author: 'argenis',
        timestamp: '2026-06-10T12:00:00Z',
        snippet: '…detect faces at native res…',
      },
    ]);

    const res = await searchTool().handler({
      query: 'faces',
      author: 'argenis',
      since: '2026-06-01T00:00:00Z',
    });

    expect(remoteSearchThreads).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'faces',
        author: 'argenis',
        since: '2026-06-01T00:00:00Z',
      }),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Found 1 matching message');
    expect(res.content[0].text).toContain('Pipeline work');
    expect(res.content[0].text).toContain('th-1');
    expect(res.content[0].text).toContain('detect faces');
  });

  test('reports cleanly when there are no matches', async () => {
    remoteSearchThreads.mockResolvedValue([]);

    const res = await searchTool().handler({ query: 'nonexistent' });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('No matching messages');
  });
});

describe('funny_run_checks registration', () => {
  test('is on the funny server for every provider, and its instructions point agents at it', async () => {
    const { FUNNY_MCP_SERVER } = await import('../../services/agent-watch-tool.js');
    for (const nativeBackgroundJobs of [true, false]) {
      const names = watchToolDefinitions({
        threadId: PARENT_THREAD,
        userId: USER,
        nativeBackgroundJobs,
      }).map((tool) => tool.name);
      expect(names).toContain('funny_run_checks');
    }
    expect(FUNNY_MCP_SERVER.alwaysLoad).toBe(true);
    expect(FUNNY_MCP_SERVER.instructions).toContain('mcp__funny__funny_run_checks instead of Bash');
  });
});
