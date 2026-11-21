import { describe, test, expect, beforeAll, afterAll, afterEach, vi } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { advanceTimersByTimeAsync } from '@funny/test-kit';

const { fakeJobs } = (() => ({
  fakeJobs: {
    listRunningJobs: vi.fn<() => Promise<Array<{ pid: number; exitPath: string }>>>(async () => []),
    getJob: vi.fn<(id: string) => Promise<Record<string, unknown> | undefined>>(),
    updateJob: vi.fn<(id: string, patch: Record<string, unknown>) => Promise<boolean>>(),
  },
}))();

// Mock the heavy service deps so importing the manager is cheap; deriveStatus
// itself only touches fs + process.kill, none of these.
vi.mock('../../services/agent-runner-control.js', () => ({
  isAgentRunning: () => false,
  startAgent: vi.fn(async () => undefined),
}));
vi.mock('../../services/agent-watcher-manager.js', () => ({ createOrReschedule: vi.fn() }));
vi.mock('../../services/service-registry.js', () => ({ getServices: () => ({ jobs: fakeJobs }) }));
vi.mock('../../services/thread-service/messaging.js', () => ({ sendMessage: vi.fn() }));
vi.mock('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));
vi.mock('../../services/shutdown-manager.js', () => ({
  shutdownManager: { register: vi.fn() },
  ShutdownPhase: { SERVICES: 'services' },
}));

import {
  cancelJob,
  deriveStatus,
  startAgentJobs,
  stopAgentJobs,
} from '../../services/agent-job-manager.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'funny-job-test-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  stopAgentJobs();
  fakeJobs.listRunningJobs.mockReset();
  fakeJobs.listRunningJobs.mockResolvedValue([]);
  fakeJobs.getJob.mockReset();
  fakeJobs.updateJob.mockReset();
  vi.useRealTimers();
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

describe('job scanner lifecycle', () => {
  test('does not keep polling the repository when there are no running jobs', async () => {
    vi.useFakeTimers();

    startAgentJobs();
    await flushMicrotasks();

    expect(fakeJobs.listRunningJobs).toHaveBeenCalledTimes(1);
    await advanceTimersByTimeAsync(60_000);
    expect(fakeJobs.listRunningJobs).toHaveBeenCalledTimes(1);
  });

  test('continues polling while a job is running', async () => {
    vi.useFakeTimers();
    fakeJobs.listRunningJobs.mockResolvedValue([
      { pid: process.pid, exitPath: join(dir, 'still-running') },
    ]);

    startAgentJobs();
    await flushMicrotasks();
    expect(fakeJobs.listRunningJobs).toHaveBeenCalledTimes(1);

    await advanceTimersByTimeAsync(5_000);
    expect(fakeJobs.listRunningJobs).toHaveBeenCalledTimes(2);
  });
});

describe('cancelJob', () => {
  const job = (status: string) => ({ id: 'j1', userId: 'u1', threadId: 't1', pid: null, status });

  test('cancels a running job', async () => {
    fakeJobs.getJob.mockResolvedValue(job('running'));
    fakeJobs.updateJob.mockResolvedValue(true);

    expect(await cancelJob('j1', 'u1')).toBe('cancelled');
    expect(fakeJobs.updateJob).toHaveBeenCalledWith('j1', { status: 'cancelled' });
  });

  test('leaves a finished job as it ended, and says how it ended', async () => {
    fakeJobs.getJob.mockResolvedValue(job('exited'));

    expect(await cancelJob('j1', 'u1')).toBe('exited');
    expect(fakeJobs.updateJob).not.toHaveBeenCalled();
  });

  test('reports a job that finished while it was being cancelled', async () => {
    fakeJobs.getJob.mockResolvedValueOnce(job('running')).mockResolvedValueOnce(job('failed'));
    fakeJobs.updateJob.mockResolvedValue(false); // the store refused running → cancelled

    expect(await cancelJob('j1', 'u1')).toBe('failed');
  });

  test('answers null for a job the caller does not have', async () => {
    fakeJobs.getJob.mockResolvedValue({ ...job('running'), userId: 'someone-else' });
    expect(await cancelJob('j1', 'u1')).toBeNull();
  });
});

/** Stand-in for vitest's `vi.runAllTicks()`: let pending promise callbacks run. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
