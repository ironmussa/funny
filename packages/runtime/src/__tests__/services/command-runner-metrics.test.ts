import { describe, expect, test, vi } from 'vitest';

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: {
      getProject: vi.fn().mockResolvedValue({ id: 'project-a', userId: 'user-a' }),
    },
  }),
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: {
    emitToUser: vi.fn(),
  },
}));

vi.mock('../../services/shutdown-manager.js', () => ({
  ShutdownPhase: { SERVICES: 'services' },
  shutdownManager: {
    register: vi.fn(),
  },
}));

import { parseRssByPid, readRssByPid } from '../../services/command-runner.js';

describe('command metrics sampling', () => {
  test('parses multi-pid ps output and skips malformed lines', () => {
    const parsed = parseRssByPid('  101  2048\n202 4096\n\ngarbage\n');
    expect([...parsed]).toEqual([
      [101, 2048],
      [202, 4096],
    ]);
  });

  test.skipIf(process.platform === 'win32')(
    'reads RSS asynchronously in one call and omits pids that no longer exist',
    async () => {
      const missingPid = 2 ** 22 + 12345;
      const rss = await readRssByPid([process.pid, missingPid]);
      expect(rss.get(process.pid)).toBeGreaterThan(0);
      expect(rss.has(missingPid)).toBe(false);
    },
  );

  test('no pids means no process spawned', async () => {
    expect((await readRssByPid([])).size).toBe(0);
  });
});
