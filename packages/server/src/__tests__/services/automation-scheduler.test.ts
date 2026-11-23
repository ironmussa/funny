/**
 * Server automation scheduler: scheduling lifecycle (fake cron) and run
 * bookkeeping (fake launcher, real test DB).
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, spyOn } from 'bun:test';

import { Cron } from 'croner';
import { eq } from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import {
  STALE_RUN_MS,
  createCronJob,
  rescheduleAutomation,
  runAutomation,
  scheduledAutomationCount,
  startAutomationScheduler,
  stopAutomationScheduler,
  unscheduleAutomation,
  type AutomationJob,
} from '../../services/automation-scheduler.js';
import * as browserEvents from '../../services/browser-events.js';
import type { StartThreadInput } from '../../services/runner-thread-launcher.js';
import {
  expectInstance,
  launchedThread,
  runnerOffline,
  unusedRunnerPorts,
  type LaunchResult,
} from '../helpers/builders-services.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedAutomation, seedAutomationRun, seedProject, seedThread } from '../helpers/test-db.js';

const NEXT = new Date('2030-01-01T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
/** The occurrence after `NEXT`: what a job answers once `NEXT` has been reached. */
const FOLLOWING = new Date(NEXT.getTime() + DAY_MS);

interface FakeJob {
  /** Reach the job's next occurrence, as its timer would. */
  onTick: () => Promise<void>;
  /** Reach the SAME occurrence again, as another server process's timer would. */
  onPeerTick: () => Promise<void>;
  stopped: boolean;
}

/**
 * Fake cron: records jobs by pattern and lets the test fire them. As with
 * croner, once an occurrence is reached the job's next run is the following one.
 */
function fakeCron() {
  const live = new Map<string, FakeJob>();
  const createJob = (pattern: string, onTick: () => Promise<void>): AutomationJob => {
    if (pattern === 'not a cron') throw new Error('invalid pattern');
    let at = NEXT;
    const entry: FakeJob = {
      onTick: () => {
        at = new Date(at.getTime() + DAY_MS);
        return onTick();
      },
      onPeerTick: onTick,
      stopped: false,
    };
    live.set(pattern, entry);
    return {
      stop: () => {
        entry.stopped = true;
      },
      nextRun: () => at,
    };
  };
  return { createJob, live };
}

/** Fake launcher. On success the real launcher registers the thread row, so seed it. */
function fakeLauncher(result: 'ok' | 'offline' = 'ok', register?: (threadId: string) => void) {
  const calls: StartThreadInput[] = [];
  const launch = async (input: StartThreadInput): Promise<LaunchResult> => {
    calls.push(input);
    if (result === 'ok') register?.(`t-${calls.length}`);
    return result === 'ok'
      ? launchedThread(`t-${calls.length}`)
      : runnerOffline('No online runner found for this project');
  };
  return { calls, launch };
}

const ports = unusedRunnerPorts();

/** What the scheduler recorded as server activities. */
function fakeActivities() {
  const recorded: Array<{ spec: any; outcome: any }> = [];
  return {
    recorded,
    activities: {
      recordServerActivity: async (spec: any, outcome: any) => {
        recorded.push({ spec, outcome });
      },
    },
  };
}

describe('automation scheduler', () => {
  let t: TestApp;
  const automation = (id: string) => {
    const row = t.db.select().from(schema.automations).where(eq(schema.automations.id, id)).get();
    if (!row) throw new Error(`no automation ${id}`);
    return row;
  };
  const runs = () => t.db.select().from(schema.automationRuns).all();
  const register = (id: string) => seedThread(t.db, { id, projectId: 'p1', userId: 'alice' });

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db, { id: 'p1', userId: 'alice', path: '/repo' });
  });

  afterEach(() => stopAutomationScheduler());

  describe('scheduling', () => {
    test('schedules enabled automations only, and records nextRunAt', async () => {
      seedAutomation(t.db, { id: 'on', projectId: 'p1', schedule: '0 9 * * *' });
      seedAutomation(t.db, {
        id: 'off',
        projectId: 'p1',
        schedule: '0 10 * * *',
        enabled: 0,
      });
      const cron = fakeCron();

      await startAutomationScheduler({
        ports,
        createJob: cron.createJob,
        launch: fakeLauncher().launch,
      });

      expect([...cron.live.keys()]).toEqual(['0 9 * * *']);
      expect(automation('on').nextRunAt).toBe(NEXT.toISOString());
    });

    test('does not run anything on start (no catch-up)', async () => {
      seedAutomation(t.db, {
        id: 'on',
        projectId: 'p1',
        lastRunAt: '2020-01-01T00:00:00Z',
      });
      const launcher = fakeLauncher();

      await startAutomationScheduler({
        ports,
        createJob: fakeCron().createJob,
        launch: launcher.launch,
      });

      expect(launcher.calls).toEqual([]);
    });

    test('a tick starts a run for the automation owner', async () => {
      seedAutomation(t.db, {
        id: 'on',
        projectId: 'p1',
        userId: 'alice',
        schedule: '0 9 * * *',
      });
      const cron = fakeCron();
      const launcher = fakeLauncher('ok', register);
      await startAutomationScheduler({ ports, createJob: cron.createJob, launch: launcher.launch });

      cron.live.get('0 9 * * *')!.onTick();
      await Bun.sleep(20);

      expect(launcher.calls).toHaveLength(1);
      expect(launcher.calls[0].userId).toBe('alice');
    });

    // #185: croner's `protect` only skips a tick while the previous one's
    // promise is pending; `void fire(id)` made every tick look finished at once.
    test('a tick settles only once its run is recorded, so protect can skip overlaps', async () => {
      seedAutomation(t.db, {
        id: 'on',
        projectId: 'p1',
        userId: 'alice',
        schedule: '0 9 * * *',
      });
      const cron = fakeCron();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const inner = fakeLauncher('ok', register);
      const launch = async (input: StartThreadInput) => {
        await gate;
        return inner.launch(input);
      };
      await startAutomationScheduler({ ports, createJob: cron.createJob, launch });

      let settled = false;
      const tick = cron.live.get('0 9 * * *')!.onTick();
      expect(tick).toBeInstanceOf(Promise);
      void tick.then(() => (settled = true));
      await Bun.sleep(20);
      expect(settled).toBe(false);

      release();
      await tick;
      expect(runs()).toHaveLength(1);
    });

    test('a failing tick is logged and never becomes an unhandled rejection', async () => {
      seedAutomation(t.db, { id: 'on', projectId: 'p1', schedule: '0 9 * * *' });
      const cron = fakeCron();
      const launch = async (): Promise<LaunchResult> => {
        throw new Error('db down');
      };
      await startAutomationScheduler({ ports, createJob: cron.createJob, launch });

      const logged = spyOn(log, 'error');
      try {
        const tick = cron.live.get('0 9 * * *')!.onTick();
        expect(tick).toBeInstanceOf(Promise);
        await expect(tick).resolves.toBeUndefined();
        expect(logged).toHaveBeenCalledWith(
          'Automation tick failed',
          expect.objectContaining({ automationId: 'on', error: 'db down' }),
        );
      } finally {
        logged.mockRestore();
      }
    });

    test('croner treats the job as busy until the tick settles', async () => {
      let release!: () => void;
      const job = expectInstance(
        createCronJob('0 9 * * *', () => new Promise<void>((resolve) => (release = resolve))),
        Cron,
      );
      try {
        const run = job.trigger();
        expect(job.isBusy()).toBe(true);
        release();
        await run;
        expect(job.isBusy()).toBe(false);
      } finally {
        job.stop();
      }
    });

    describe('one run per occurrence across server processes (openspec automation-occurrence-claims)', () => {
      const start = async () => {
        seedAutomation(t.db, { id: 'on', projectId: 'p1', userId: 'alice', schedule: '0 9 * * *' });
        const cron = fakeCron();
        const launcher = fakeLauncher('ok', register);
        const { recorded, activities } = fakeActivities();
        await startAutomationScheduler({
          ports,
          createJob: cron.createJob,
          launch: launcher.launch,
          activities,
        });
        return { job: cron.live.get('0 9 * * *')!, launcher, recorded };
      };

      test('a second process reaching the same occurrence starts nothing and records no skip', async () => {
        const { job, launcher, recorded } = await start();

        await job.onTick();
        await job.onPeerTick();

        expect(launcher.calls).toHaveLength(1);
        expect(runs()).toHaveLength(1);
        expect(recorded).toEqual([]);
        expect(automation('on').nextRunAt).toBe(FOLLOWING.toISOString());
      });

      test('two processes reaching the occurrence at once start one run', async () => {
        const { job, launcher } = await start();

        await Promise.all([job.onTick(), job.onPeerTick()]);

        expect(launcher.calls).toHaveLength(1);
        expect(runs()).toHaveLength(1);
      });

      test('the next occurrence starts a run again', async () => {
        const { job, launcher } = await start();
        await job.onTick();
        t.db.update(schema.automationRuns).set({ status: 'completed' }).run();

        await job.onTick();

        expect(launcher.calls).toHaveLength(2);
      });

      test('an automation with no next run time stored is taken once', async () => {
        const { job, launcher } = await start();
        t.db.update(schema.automations).set({ nextRunAt: null }).run();

        await job.onTick();
        await job.onPeerTick();

        expect(launcher.calls).toHaveLength(1);
      });

      test('a manual run takes no occurrence: the scheduled one still runs', async () => {
        const { job, launcher } = await start();

        const manual = await runAutomation(automation('on'));
        expect(manual.isOk()).toBe(true);
        expect(automation('on').nextRunAt).toBe(NEXT.toISOString());
        t.db.update(schema.automationRuns).set({ status: 'completed' }).run();
        await job.onTick();

        expect(launcher.calls).toHaveLength(2);
      });
    });

    describe('a tick while the previous run is still going', () => {
      const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
      const start = async () => {
        seedAutomation(t.db, {
          id: 'on',
          projectId: 'p1',
          userId: 'alice',
          schedule: '0 9 * * *',
        });
        const cron = fakeCron();
        const launcher = fakeLauncher('ok', register);
        const { recorded, activities } = fakeActivities();
        await startAutomationScheduler({
          ports,
          createJob: cron.createJob,
          launch: launcher.launch,
          activities,
        });
        return { tick: () => cron.live.get('0 9 * * *')!.onTick(), launcher, recorded };
      };
      const previousRun = (status: string, startedAt: string) => {
        seedThread(t.db, { id: 'prev', projectId: 'p1', userId: 'alice' });
        seedAutomationRun(t.db, {
          id: 'r-prev',
          automationId: 'on',
          threadId: 'prev',
          status,
          startedAt,
          completedAt: status === 'running' ? null : startedAt,
        });
      };

      test('is skipped, and the next occurrence is still recorded', async () => {
        const { tick, launcher } = await start();
        previousRun('running', ago(60_000));
        t.db.update(schema.automations).set({ nextRunAt: null }).run();

        await tick();

        expect(launcher.calls).toEqual([]);
        expect(runs()).toHaveLength(1);
        expect(automation('on').nextRunAt).toBe(FOLLOWING.toISOString());
      });

      test('the first skip of a running run is recorded, the rest of the streak is not', async () => {
        const { tick, recorded } = await start();
        previousRun('running', ago(60_000));

        await tick();
        await tick();
        await tick();

        const skips = recorded.filter((r) => r.spec.kind === 'automation.skipped');
        expect(skips).toHaveLength(1);
        expect(skips[0]!.spec).toMatchObject({
          userId: 'alice',
          origin: 'system',
          input: { automationId: 'on' },
        });
        expect(skips[0]!.outcome).toEqual({ ok: true });
      });

      test('a skip of a later run is recorded again', async () => {
        const { tick, recorded } = await start();
        previousRun('running', ago(60_000));
        await tick();
        // The run finishes, a new one starts and runs past the next tick.
        t.db.update(schema.automationRuns).set({ status: 'completed' }).run();
        await tick();
        seedThread(t.db, { id: 'next', projectId: 'p1', userId: 'alice' });
        seedAutomationRun(t.db, {
          id: 'r-next',
          automationId: 'on',
          threadId: 'next',
          status: 'running',
          startedAt: ago(1_000),
        });
        await tick();

        expect(recorded.filter((r) => r.spec.kind === 'automation.skipped')).toHaveLength(2);
      });

      test('runs when the previous run has finished', async () => {
        const { tick, launcher } = await start();
        previousRun('completed', ago(60_000));

        await tick();

        expect(launcher.calls).toHaveLength(1);
      });

      test('runs when the previous run is stale (no completion for over a day)', async () => {
        const { tick, launcher } = await start();
        previousRun('running', ago(STALE_RUN_MS + 60_000));

        await tick();

        expect(launcher.calls).toHaveLength(1);
      });

      test('does not stop a manual run', async () => {
        const { launcher } = await start();
        previousRun('running', ago(60_000));

        const started = await runAutomation(automation('on'));

        expect(started.isOk()).toBe(true);
        expect(launcher.calls).toHaveLength(1);
      });
    });

    test('a tick for an automation disabled since scheduling does nothing', async () => {
      seedAutomation(t.db, { id: 'on', projectId: 'p1', schedule: '0 9 * * *' });
      const cron = fakeCron();
      const launcher = fakeLauncher();
      await startAutomationScheduler({ ports, createJob: cron.createJob, launch: launcher.launch });

      t.db.update(schema.automations).set({ enabled: 0 }).run();
      cron.live.get('0 9 * * *')!.onTick();
      await Bun.sleep(20);

      expect(launcher.calls).toEqual([]);
    });

    test('reschedule follows a schedule change; disabling clears nextRunAt', async () => {
      seedAutomation(t.db, { id: 'a', projectId: 'p1', schedule: '0 9 * * *' });
      const cron = fakeCron();
      await startAutomationScheduler({
        ports,
        createJob: cron.createJob,
        launch: fakeLauncher().launch,
      });

      t.db.update(schema.automations).set({ schedule: '0 18 * * *' }).run();
      await rescheduleAutomation('a');
      expect(cron.live.get('0 9 * * *')!.stopped).toBe(true);
      expect(cron.live.get('0 18 * * *')!.stopped).toBe(false);

      t.db.update(schema.automations).set({ enabled: 0 }).run();
      await rescheduleAutomation('a');
      expect(cron.live.get('0 18 * * *')!.stopped).toBe(true);
      expect(automation('a').nextRunAt).toBeNull();
      expect(scheduledAutomationCount()).toBe(0);
    });

    test('unschedule stops a deleted automation from firing', async () => {
      seedAutomation(t.db, { id: 'a', projectId: 'p1', schedule: '0 9 * * *' });
      const cron = fakeCron();
      await startAutomationScheduler({
        ports,
        createJob: cron.createJob,
        launch: fakeLauncher().launch,
      });

      unscheduleAutomation('a');

      expect(cron.live.get('0 9 * * *')!.stopped).toBe(true);
      expect(scheduledAutomationCount()).toBe(0);
    });

    test('an invalid schedule is skipped without breaking the others', async () => {
      seedAutomation(t.db, { id: 'bad', projectId: 'p1', schedule: 'not a cron' });
      seedAutomation(t.db, { id: 'good', projectId: 'p1', schedule: '0 9 * * *' });

      const { recorded, activities } = fakeActivities();
      await startAutomationScheduler({
        ports,
        createJob: fakeCron().createJob,
        launch: fakeLauncher().launch,
        activities,
      });

      expect(scheduledAutomationCount()).toBe(1);
      // Its owner is told it will not run.
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.spec).toMatchObject({
        kind: 'automation.unscheduled',
        input: { automationId: 'bad', schedule: 'not a cron' },
      });
      expect(recorded[0]!.outcome.ok).toBe(false);
    });
  });

  describe('run bookkeeping', () => {
    test('a dispatched run is recorded as running and the thread is read-only', async () => {
      seedAutomation(t.db, {
        id: 'a',
        projectId: 'p1',
        userId: 'alice',
        prompt: 'look',
      });
      const launcher = fakeLauncher('ok', register);
      await startAutomationScheduler({
        ports,
        createJob: fakeCron().createJob,
        launch: launcher.launch,
      });

      const result = await runAutomation(automation('a'));

      const { runId, threadId } = result._unsafeUnwrap();
      expect(runs()).toEqual([
        expect.objectContaining({
          id: runId,
          threadId,
          status: 'running',
          triageStatus: 'pending',
        }),
      ]);
      expect(automation('a').lastRunAt).not.toBeNull();
      expect(launcher.calls[0].body).toMatchObject({
        projectId: 'p1',
        source: 'automation',
        mode: 'local',
        prompt: 'look',
        disallowedTools: ['Edit', 'Write', 'Bash', 'NotebookEdit'],
      });
    });

    test("owner's runner offline → failed run in history with the reason", async () => {
      seedAutomation(t.db, { id: 'a', projectId: 'p1', userId: 'alice' });
      await startAutomationScheduler({
        ports,
        createJob: fakeCron().createJob,
        launch: fakeLauncher('offline').launch,
      });

      const result = await runAutomation(automation('a'));

      expect(result._unsafeUnwrapErr().kind).toBe('runner-unavailable');
      const [run] = runs();
      expect(run).toMatchObject({ status: 'failed', triageStatus: 'pending' });
      expect(run.summary).toContain('No online runner found');
      const placeholder = t.db
        .select()
        .from(schema.threads)
        .where(eq(schema.threads.id, run.threadId))
        .get();
      expect(placeholder).toMatchObject({ userId: 'alice', archived: 1, status: 'failed' });
    });

    test('runs stuck in running for over a day are failed on start', async () => {
      seedAutomation(t.db, { id: 'a', projectId: 'p1' });
      seedThread(t.db, { id: 'old', projectId: 'p1' });
      seedThread(t.db, { id: 'fresh', projectId: 'p1' });
      const at = (ms: number) => new Date(Date.now() - ms).toISOString();
      t.db
        .insert(schema.automationRuns)
        .values([
          {
            id: 'r-old',
            automationId: 'a',
            threadId: 'old',
            status: 'running',
            startedAt: at(STALE_RUN_MS + 60_000),
          },
          {
            id: 'r-fresh',
            automationId: 'a',
            threadId: 'fresh',
            status: 'running',
            startedAt: at(60_000),
          },
        ])
        .run();

      await startAutomationScheduler({
        ports,
        createJob: fakeCron().createJob,
        launch: fakeLauncher().launch,
      });

      const byId = Object.fromEntries(runs().map((r: any) => [r.id, r.status]));
      expect(byId).toEqual({ 'r-old': 'failed', 'r-fresh': 'running' });
    });

    test('runs that go stale while the server is up are failed by the periodic sweep (#198)', async () => {
      seedAutomation(t.db, { id: 'a', projectId: 'p1', userId: 'alice' });
      seedThread(t.db, { id: 'lost', projectId: 'p1' });
      let sweep: (() => Promise<void>) | null = null;
      let sweepStopped = false;
      let clock = new Date('2030-01-01T00:00:00.000Z');

      await startAutomationScheduler({
        ports,
        createJob: fakeCron().createJob,
        launch: fakeLauncher().launch,
        now: () => clock,
        startSweep: (onSweep) => {
          sweep = onSweep;
          return {
            stop: () => {
              sweepStopped = true;
            },
          };
        },
      });

      // The run starts after startup's sweep, and its runner never reports back.
      t.db
        .insert(schema.automationRuns)
        .values({
          id: 'r-lost',
          automationId: 'a',
          threadId: 'lost',
          status: 'running',
          startedAt: clock.toISOString(),
        })
        .run();

      const relayed = spyOn(browserEvents, 'relayToUser');
      await sweep!();
      expect(runs()[0].status).toBe('running');

      clock = new Date(clock.getTime() + STALE_RUN_MS + 60_000);
      await sweep!();
      expect(runs()[0]).toMatchObject({
        status: 'failed',
        summary: 'No completion was reported for this run',
      });
      // An open browser learns the run finished without a reload.
      expect(relayed).toHaveBeenCalledTimes(1);
      expect(relayed.mock.calls[0][0]).toBe('alice');
      expect(relayed.mock.calls[0][1]).toMatchObject({
        type: 'automation:run_completed',
        threadId: 'lost',
        data: { automationId: 'a', runId: 'r-lost', hasFindings: false },
      });

      // A run already failed is left alone (and not announced twice).
      await sweep!();
      expect(relayed).toHaveBeenCalledTimes(1);
      relayed.mockRestore();

      stopAutomationScheduler();
      expect(sweepStopped).toBe(true);
    });
  });
});
