import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emitToUser: vi.fn(),
  // Set per test to return canned `ps` output; null = pass through to the real execute.
  psOverride: null as
    | null
    | ((args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>),
  execute: vi.fn(),
}));

vi.mock('@funny/core/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@funny/core/git')>();
  mocks.execute.mockImplementation((command: string, args: string[], options?: unknown) =>
    mocks.psOverride && command === 'ps'
      ? mocks.psOverride(args)
      : actual.execute(command, args, options as Parameters<typeof actual.execute>[2]),
  );
  return { ...actual, execute: mocks.execute };
});

// No-op logger: winston schedules its own timers, which would pollute vi.getTimerCount().
vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: {
      getProject: vi.fn().mockResolvedValue({ id: 'project-a', userId: 'user-a' }),
    },
  }),
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: {
    emitToUser: mocks.emitToUser,
  },
}));

vi.mock('../../services/shutdown-manager.js', () => ({
  ShutdownPhase: { SERVICES: 'services' },
  shutdownManager: {
    register: vi.fn(),
  },
}));

import { log } from '../../lib/logger.js';
import {
  parseRssByPid,
  readRssByPid,
  startCommand,
  stopAllCommands,
  stopCommand,
} from '../../services/command-runner.js';

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

// ── Metrics timer lifecycle ─────────────────────────────────

const INTERVAL_MS = 10_000;

type MetricsEvent = { commandId: string; memoryUsageKB: number };

function metricsEvents(): MetricsEvent[] {
  return mocks.emitToUser.mock.calls
    .map(([, event]) => event as { type: string; data: MetricsEvent })
    .filter((event) => event.type === 'command:metrics')
    .map((event) => event.data);
}

function psCalls(): string[][] {
  return mocks.execute.mock.calls
    .filter(([command]) => command === 'ps')
    .map(([, args]) => args as string[]);
}

/** Canned `ps` output: every requested pid reports `kbFor(pid)`. */
function cannedPs(kbFor: (pid: number) => number) {
  mocks.psOverride = async (args) => {
    const pids = args[args.indexOf('-p') + 1].split(',').map(Number);
    return {
      stdout: pids.map((pid) => `${pid} ${kbFor(pid)}`).join('\n'),
      stderr: '',
      exitCode: 0,
    };
  };
}

async function start(commandId: string) {
  const result = await startCommand(commandId, 'sleep 30', process.cwd(), 'project-a', commandId);
  expect(result.isOk()).toBe(true);
}

describe.skipIf(process.platform === 'win32')('command metrics timer lifecycle', () => {
  afterEach(async () => {
    await stopAllCommands();
    vi.useRealTimers();
    mocks.psOverride = null;
    mocks.execute.mockClear();
    mocks.emitToUser.mockClear();
  });

  test('samples all live commands with ONE ps call and emits command:metrics per command', async () => {
    vi.useFakeTimers();
    cannedPs((pid) => 1000 + (pid % 1000));
    await start('cmd-metrics-a');
    await start('cmd-metrics-b');
    mocks.execute.mockClear();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 100);
    await vi.waitFor(() => expect(metricsEvents()).toHaveLength(2));

    expect(psCalls()).toHaveLength(1);
    const [args] = psCalls();
    expect(args.slice(0, 3)).toEqual(['-o', 'pid=,rss=', '-p']);
    expect(args[3].split(',')).toHaveLength(2);

    const byId = new Map(metricsEvents().map((e) => [e.commandId, e]));
    expect([...byId.keys()].sort()).toEqual(['cmd-metrics-a', 'cmd-metrics-b']);
    for (const event of byId.values()) {
      expect(typeof event.memoryUsageKB).toBe('number');
      expect(event.memoryUsageKB).toBeGreaterThan(0);
    }
  });

  test('real ps: a live command reports memoryUsageKB > 0 after one interval', async () => {
    vi.useFakeTimers();
    await start('cmd-metrics-real');

    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 100);
    // `ps` is real child-process I/O; let it complete outside the fake clock.
    vi.useRealTimers();
    await vi.waitFor(() => expect(metricsEvents()).toHaveLength(1), {
      timeout: 5_000,
    });

    const [event] = metricsEvents();
    expect(event.commandId).toBe('cmd-metrics-real');
    expect(event.memoryUsageKB).toBeGreaterThan(0);
  });

  test('stopping the last command (stopCommand) stops the schedule', async () => {
    vi.useFakeTimers();
    cannedPs(() => 2048);
    await start('cmd-metrics-stop');

    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 100);
    await vi.waitFor(() => expect(psCalls()).toHaveLength(1));

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await stopCommand('cmd-metrics-stop');
    // ps alone can't prove the stop (empty pid list short-circuits before ps),
    // so also assert the schedule left no pending sleep timer behind.
    expect(vi.getTimerCount()).toBe(0);
    mocks.execute.mockClear();
    mocks.emitToUser.mockClear();

    await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);
    expect(psCalls()).toHaveLength(0);
    expect(metricsEvents()).toHaveLength(0);
  });

  test('stopAllCommands stops the schedule', async () => {
    vi.useFakeTimers();
    cannedPs(() => 2048);
    await start('cmd-metrics-all-a');
    await start('cmd-metrics-all-b');

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await stopAllCommands();
    expect(vi.getTimerCount()).toBe(0);
    mocks.execute.mockClear();
    mocks.emitToUser.mockClear();

    await vi.advanceTimersByTimeAsync(3 * INTERVAL_MS);
    expect(psCalls()).toHaveLength(0);
    expect(metricsEvents()).toHaveLength(0);
  });

  test('schedule keeps running while one command remains, and restarts after a new start', async () => {
    vi.useFakeTimers();
    cannedPs(() => 4096);
    await start('cmd-metrics-keep-a');
    await start('cmd-metrics-keep-b');

    await stopCommand('cmd-metrics-keep-a');
    mocks.execute.mockClear();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 100);
    await vi.waitFor(() => expect(psCalls()).toHaveLength(1));
    expect(psCalls()[0][3].split(',')).toHaveLength(1);

    await stopCommand('cmd-metrics-keep-b');
    await start('cmd-metrics-keep-c');
    mocks.execute.mockClear();
    mocks.emitToUser.mockClear();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 100);
    await vi.waitFor(() => expect(metricsEvents()).toHaveLength(1));
    expect(metricsEvents()[0]).toMatchObject({
      commandId: 'cmd-metrics-keep-c',
      memoryUsageKB: 4096,
    });
    expect(psCalls()).toHaveLength(1);
  });

  test('a failing ps keeps the schedule alive; the next tick samples again', async () => {
    vi.useFakeTimers();
    let fail = true;
    mocks.psOverride = async (args) => {
      if (fail) throw new Error('ps exploded');
      const pid = args[args.indexOf('-p') + 1];
      return { stdout: `${pid} 777`, stderr: '', exitCode: 0 };
    };
    await start('cmd-metrics-fail');
    mocks.execute.mockClear();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 100);
    await vi.waitFor(() => expect(metricsEvents()).toHaveLength(1));
    // readRssByPid swallowed the failure — previous sample (0) is kept.
    expect(metricsEvents()[0].memoryUsageKB).toBe(0);

    fail = false;
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.waitFor(() => expect(metricsEvents()).toHaveLength(2));
    expect(metricsEvents()[1].memoryUsageKB).toBe(777);
    expect(psCalls()).toHaveLength(2);
  });

  test('a failing metrics emit is logged, not left as an unhandled rejection', async () => {
    vi.useFakeTimers();
    cannedPs(() => 1234);
    mocks.emitToUser.mockImplementation((_userId: string, event: { type: string }) => {
      if (event.type === 'command:metrics') throw new Error('socket gone');
    });
    try {
      await start('cmd-metrics-emit-fail');
      await vi.advanceTimersByTimeAsync(INTERVAL_MS + 100);
      await vi.waitFor(() =>
        expect(log.warn).toHaveBeenCalledWith(
          'Command metrics emit failed',
          expect.objectContaining({ commandId: 'cmd-metrics-emit-fail', error: 'socket gone' }),
        ),
      );
    } finally {
      mocks.emitToUser.mockReset();
    }
  });
});
