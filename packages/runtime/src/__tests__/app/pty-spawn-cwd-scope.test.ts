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

const { mockSpawnPty, mockGetLocalProjects, mockListProjects } = vi.hoisted(() => ({
  mockSpawnPty: vi.fn(),
  mockGetLocalProjects: vi.fn(),
  mockListProjects: vi.fn(),
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
  getThread: vi.fn(),
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
  });

  test('cache MISS falls through to the server list and allows a known project', async () => {
    // Stale cache (warmed before the project existed) does not contain it...
    mockGetLocalProjects.mockReturnValue([{ path: '/home/user/other' }]);
    // ...but the authoritative server list does.
    mockListProjects.mockResolvedValue([{ path: PROJECT_PATH }]);

    const send = spawn();

    await vi.waitFor(() => expect(mockSpawnPty).toHaveBeenCalledTimes(1));
    expect(mockListProjects).toHaveBeenCalledWith('user-1');
    expect(send).not.toHaveBeenCalled(); // no pty:error
  });

  test('cache HIT authorizes immediately without a server roundtrip', async () => {
    mockGetLocalProjects.mockReturnValue([{ path: PROJECT_PATH }]);
    mockListProjects.mockResolvedValue([]);

    const send = spawn();

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
