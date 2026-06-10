import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

// Mock the heavy service deps so importing the manager is cheap; deriveStatus
// itself only touches fs + process.kill, none of these.
vi.mock('../../services/agent-runner.js', () => ({ isAgentRunning: () => false }));
vi.mock('../../services/agent-watcher-manager.js', () => ({ createOrReschedule: vi.fn() }));
vi.mock('../../services/service-registry.js', () => ({ getServices: () => ({ jobs: {} }) }));
vi.mock('../../services/thread-service/messaging.js', () => ({ sendMessage: vi.fn() }));
vi.mock('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));
vi.mock('../../services/shutdown-manager.js', () => ({
  shutdownManager: { register: vi.fn() },
  ShutdownPhase: { SERVICES: 'services' },
}));

import { deriveStatus } from '../../services/agent-job-manager.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'funny-job-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('deriveStatus', () => {
  test('exitfile EXIT=0 → exited', () => {
    const exitPath = join(dir, 'exit-ok');
    writeFileSync(exitPath, 'EXIT=0\n');
    expect(deriveStatus({ pid: 1, exitPath })).toEqual({ status: 'exited', exitCode: 0 });
  });

  test('exitfile EXIT=137 → failed with code', () => {
    const exitPath = join(dir, 'exit-fail');
    writeFileSync(exitPath, 'EXIT=137\n');
    expect(deriveStatus({ pid: 1, exitPath })).toEqual({ status: 'failed', exitCode: 137 });
  });

  test('no exitfile + live pid → running', () => {
    // process.pid is definitely alive.
    expect(deriveStatus({ pid: process.pid, exitPath: join(dir, 'missing') })).toEqual({
      status: 'running',
      exitCode: null,
    });
  });

  test('no exitfile + dead pid → killed (external SIGKILL case)', () => {
    // A pid that is almost certainly not a live process.
    expect(deriveStatus({ pid: 2_147_483_646, exitPath: join(dir, 'missing2') })).toEqual({
      status: 'killed',
      exitCode: null,
    });
  });

  test('no exitfile + null pid → killed', () => {
    expect(deriveStatus({ pid: null, exitPath: join(dir, 'missing3') })).toEqual({
      status: 'killed',
      exitCode: null,
    });
  });
});
