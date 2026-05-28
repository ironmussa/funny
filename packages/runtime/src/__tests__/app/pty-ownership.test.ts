/**
 * Security CR-2 regression tests — pty:write / kill / resize / signal /
 * restore must reject when the session doesn't belong to the requesting
 * user. Without the gate, any authenticated user who learned another
 * tenant's `ptyId` could inject keystrokes into their running shell.
 */
import { describe, expect, test, vi, beforeEach } from 'vitest';

// Mock pty-manager BEFORE importing the handler so its `import * as
// ptyManager` resolves to the stubs.
const {
  mockAssertSessionAccess,
  mockWritePty,
  mockKillPty,
  mockResizePty,
  mockSignalPty,
  mockCapturePaneAsync,
  mockSpawnPty,
} = vi.hoisted(() => ({
  mockAssertSessionAccess: vi.fn(),
  mockWritePty: vi.fn(),
  mockKillPty: vi.fn(),
  mockResizePty: vi.fn(),
  mockSignalPty: vi.fn(),
  mockCapturePaneAsync: vi.fn(),
  mockSpawnPty: vi.fn(),
}));

vi.mock('../../services/pty-manager.js', () => ({
  assertSessionAccess: mockAssertSessionAccess,
  writePty: mockWritePty,
  killPty: mockKillPty,
  resizePty: mockResizePty,
  signalPty: mockSignalPty,
  capturePaneAsync: mockCapturePaneAsync,
  spawnPty: mockSpawnPty,
}));

vi.mock('../../services/thread-manager.js', () => ({
  getThread: vi.fn(),
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: { listProjects: vi.fn().mockResolvedValue([]) },
  }),
}));

vi.mock('../../services/thread-context.js', () => ({
  scratchPathFor: (userId: string, threadId: string) => `/tmp/scratch/${userId}/${threadId}`,
}));

import { handlePtyMessage } from '../../app/pty-message-handler.js';

describe('handlePtyMessage ownership gate (security CR-2)', () => {
  beforeEach(() => {
    mockAssertSessionAccess.mockReset();
    mockWritePty.mockReset();
    mockKillPty.mockReset();
    mockResizePty.mockReset();
    mockSignalPty.mockReset();
    mockCapturePaneAsync.mockReset();
  });

  test('pty:write — denies when session is owned by another user', () => {
    mockAssertSessionAccess.mockReturnValue(false);
    const send = vi.fn();
    handlePtyMessage('pty:write', { id: 'pty-alice', data: 'whoami\n' }, 'mallory', send);
    expect(mockAssertSessionAccess).toHaveBeenCalledWith('pty-alice', 'mallory');
    expect(mockWritePty).not.toHaveBeenCalled();
  });

  test('pty:write — allows when session is owned by the caller', () => {
    mockAssertSessionAccess.mockReturnValue(true);
    const send = vi.fn();
    handlePtyMessage('pty:write', { id: 'pty-alice', data: 'whoami\n' }, 'alice', send);
    expect(mockWritePty).toHaveBeenCalledWith('pty-alice', 'whoami\n');
  });

  test('pty:kill — denies when not owned', () => {
    mockAssertSessionAccess.mockReturnValue(false);
    handlePtyMessage('pty:kill', { id: 'pty-alice' }, 'mallory', vi.fn());
    expect(mockKillPty).not.toHaveBeenCalled();
  });

  test('pty:resize — denies when not owned', () => {
    mockAssertSessionAccess.mockReturnValue(false);
    handlePtyMessage('pty:resize', { id: 'pty-alice', cols: 80, rows: 24 }, 'mallory', vi.fn());
    expect(mockResizePty).not.toHaveBeenCalled();
  });

  test('pty:signal — denies when not owned', () => {
    mockAssertSessionAccess.mockReturnValue(false);
    handlePtyMessage('pty:signal', { id: 'pty-alice', signal: 'SIGINT' }, 'mallory', vi.fn());
    expect(mockSignalPty).not.toHaveBeenCalled();
  });

  test('pty:restore — denies when not owned', () => {
    mockAssertSessionAccess.mockReturnValue(false);
    handlePtyMessage('pty:restore', { id: 'pty-alice' }, 'mallory', vi.fn());
    expect(mockCapturePaneAsync).not.toHaveBeenCalled();
  });

  test('all non-spawn ops drop messages missing a string id', () => {
    mockAssertSessionAccess.mockReturnValue(true);
    handlePtyMessage('pty:write', {}, 'alice', vi.fn());
    handlePtyMessage('pty:kill', { id: 123 }, 'alice', vi.fn());
    expect(mockAssertSessionAccess).not.toHaveBeenCalled();
    expect(mockWritePty).not.toHaveBeenCalled();
    expect(mockKillPty).not.toHaveBeenCalled();
  });
});
