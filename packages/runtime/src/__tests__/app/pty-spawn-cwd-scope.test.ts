/**
 * Regression tests for pty:spawn cwd scoping.
 *
 * The runner validates the spawn cwd against the user's projects. The local
 * project cache (getLocalProjects) is only an optimization warmed at startup
 * + on the runner's own create path — a project created through the
 * server-side flow won't be in it yet. A cache MISS must NOT be authoritative
 * for denial; the handler has to fall through to the authoritative server list
 * before rejecting, otherwise freshly-created projects fail with
 * "Access denied: directory not in a registered project".
 */
import { describe, expect, test, vi, beforeEach } from 'vitest';

const { mockSpawnPty, mockGetLocalProjects, mockListProjects, mockGetThread, mockMkdir } =
  vi.hoisted(() => ({
    mockSpawnPty: vi.fn(),
    mockGetLocalProjects: vi.fn(),
    mockListProjects: vi.fn(),
    mockGetThread: vi.fn(),
    mockMkdir: vi.fn(),
  }));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  mkdirSync: mockMkdir,
}));

vi.mock('../../services/pty-manager.js', () => ({
  assertSessionAccess: vi.fn(() => true),
  writePty: vi.fn(),
  killPty: vi.fn(),
  resizePty: vi.fn(),
  signalPty: vi.fn(),
  capturePaneAsync: vi.fn(),
  spawnPty: mockSpawnPty,
}));

vi.mock('../../services/thread-manager.js', () => ({
  getThread: mockGetThread,
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: { listProjects: mockListProjects },
  }),
}));

vi.mock('../../services/thread-context.js', () => ({
  scratchPathFor: (userId: string, threadId: string) => `/tmp/scratch/${userId}/${threadId}`,
}));

vi.mock('../../services/team-client.js', () => ({
  getLocalProjects: mockGetLocalProjects,
}));

import { handlePtyMessage } from '../../app/pty-message-handler.js';

const PROJECT_PATH = '/home/user/pi-harness';

function spawn(send = vi.fn()) {
  handlePtyMessage(
    'pty:spawn',
    { id: 'pty-1', cwd: PROJECT_PATH, cols: 80, rows: 24, projectId: 'p-new' },
    'user-1',
    send,
  );
  return send;
}

describe('pty:spawn cwd scoping', () => {
  beforeEach(() => {
    mockSpawnPty.mockReset();
    mockGetLocalProjects.mockReset();
    mockListProjects.mockReset();
    mockGetThread.mockReset();
    mockMkdir.mockReset();
  });

  test('resolves an owned scratch directory locally instead of trusting the client cwd', async () => {
    mockGetThread.mockResolvedValue({ userId: 'user-1', isScratch: true });
    handlePtyMessage(
      'pty:spawn',
      {
        id: 'pty-1',
        cwd: '/untrusted',
        scratchThreadId: 'scratch-1',
        cols: 80,
        rows: 24,
      },
      'user-1',
      vi.fn(),
    );

    await vi.waitFor(() => expect(mockSpawnPty).toHaveBeenCalledTimes(1));
    expect(mockGetThread).toHaveBeenCalledWith('scratch-1');
    expect(mockMkdir).toHaveBeenCalledWith('/tmp/scratch/user-1/scratch-1', { recursive: true });
    expect(mockSpawnPty).toHaveBeenCalledWith(
      'pty-1',
      '/tmp/scratch/user-1/scratch-1',
      80,
      24,
      'user-1',
      undefined,
      undefined,
      undefined,
    );
    expect(mockGetLocalProjects).not.toHaveBeenCalled();
    expect(mockListProjects).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', undefined],
    ['another user', { userId: 'user-2', isScratch: true }],
    ['not scratch', { userId: 'user-1', isScratch: false }],
  ])('rejects a scratch thread that is %s', async (_name, thread) => {
    mockGetThread.mockResolvedValue(thread);
    const send = vi.fn();
    handlePtyMessage(
      'pty:spawn',
      {
        id: 'pty-1',
        cwd: PROJECT_PATH,
        scratchThreadId: 'scratch-1',
      },
      'user-1',
      send,
    );

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        type: 'pty:error',
        data: { ptyId: 'pty-1', error: 'Access denied: scratch thread not found' },
      }),
    );
    expect(mockSpawnPty).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  test('cache MISS falls through to the server list and allows a known project', async () => {
    // Stale cache (warmed before the project existed) does not contain it...
    mockGetLocalProjects.mockReturnValue([{ path: '/home/user/other' }]);
    // ...but the authoritative server list does.
    mockListProjects.mockResolvedValue([{ path: PROJECT_PATH }]);

    spawn();

    await vi.waitFor(() => expect(mockSpawnPty).toHaveBeenCalledTimes(1));
    expect(mockListProjects).toHaveBeenCalledWith('user-1');
  });

  test('cache HIT authorizes immediately without a server roundtrip', async () => {
    mockGetLocalProjects.mockReturnValue([{ path: PROJECT_PATH }]);
    mockListProjects.mockResolvedValue([]);

    spawn();

    await vi.waitFor(() => expect(mockSpawnPty).toHaveBeenCalledTimes(1));
    expect(mockListProjects).not.toHaveBeenCalled();
  });

  test('denies when neither the cache nor the server list contains the cwd', async () => {
    mockGetLocalProjects.mockReturnValue([]);
    mockListProjects.mockResolvedValue([{ path: '/home/user/elsewhere' }]);

    const send = spawn();

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pty:error',
          data: expect.objectContaining({
            error: 'Access denied: directory not in a registered project',
          }),
        }),
      ),
    );
    expect(mockSpawnPty).not.toHaveBeenCalled();
  });
});
