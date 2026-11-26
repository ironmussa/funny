import { describe, test, expect, beforeAll, afterAll, afterEach, vi, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { DomainError } from '@funny/shared/errors';
import { advanceTimersByTimeAsync } from '@funny/test-kit';
import { okAsync } from 'neverthrow';

const { fakeJobs, fakeThreads, agentState, startAgentMock } = (() => ({
  agentState: { running: false },
  startAgentMock: vi.fn((..._args: unknown[]) => okAsync<void, DomainError>(undefined)),
  fakeThreads: {
    insertMessage: vi.fn(async () => 'msg-1'),
    insertToolCall: vi.fn(async () => 'tc-1'),
    updateToolCallOutput: vi.fn(async () => undefined),
    getThread: vi.fn(async (id: string) => ({
      id,
      userId: 'u1',
      projectId: '',
      isScratch: true,
      mode: 'local',
    })),
  },
  fakeJobs: {
    listRunningJobs: vi.fn<() => Promise<Array<{ pid: number; exitPath: string }>>>(async () => []),
    getJob: vi.fn<(id: string) => Promise<Record<string, unknown> | undefined>>(),
    updateJob: vi.fn<(id: string, patch: Record<string, unknown>) => Promise<boolean>>(),
  },
}))();

// Mock the heavy service deps so importing the manager is cheap; deriveStatus
// itself only touches fs + process.kill, none of these.
mock.module('../../services/agent-runner-control.js', () => ({
  isAgentRunning: () => agentState.running,
  startAgent: startAgentMock,
}));
mock.module('../../services/agent-watcher-manager.js', () => ({ createOrReschedule: vi.fn() }));
mock.module('../../services/service-registry.js', () => ({
  getServices: () => ({ jobs: fakeJobs, threads: fakeThreads }),
}));
mock.module('../../services/thread-service/messaging.js', () => ({ sendMessage: vi.fn() }));
mock.module('../../services/ws-broker.js', () => ({ wsBroker: { emitToUser: vi.fn() } }));
mock.module('../../services/shutdown-manager.js', () => ({
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
  startAgentMock.mockClear();
  agentState.running = false;
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

describe('job completion during an open turn', () => {
  test('waits for the turn to end, then records the end and wakes the agent (#542)', async () => {
    vi.useFakeTimers();
    const exitPath = join(dir, 'exit-during-turn');
    writeFileSync(exitPath, 'EXIT=0\n');
    const job = {
      id: 'job-1',
      threadId: 'thread-1',
      userId: 'u1',
      command: 'bun test',
      label: 'check test',
      pid: 1,
      logPath: join(dir, 'no-log'),
      exitPath,
      status: 'running',
    };
    fakeJobs.listRunningJobs.mockResolvedValue([job]);
    fakeJobs.updateJob.mockResolvedValue(true);
    agentState.running = true;

    startAgentJobs();
    await flushMicrotasks();
    // The turn is open: the job stays running and nobody is woken.
    expect(fakeJobs.updateJob).not.toHaveBeenCalled();
    expect(startAgentMock).not.toHaveBeenCalled();

    agentState.running = false;
    await advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();
    expect(fakeJobs.updateJob).toHaveBeenCalledWith('job-1', { status: 'exited', exitCode: 0 });
    expect(startAgentMock).toHaveBeenCalledTimes(1);
    expect(startAgentMock.mock.calls[0]?.[0]).toBe('thread-1');
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
