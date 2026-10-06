/**
 * Server automation scheduler: scheduling lifecycle (fake cron) and run
 * bookkeeping (fake launcher, real test DB).
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';

import { eq } from 'drizzle-orm';
import { err, ok } from 'neverthrow';

import * as schema from '../../db/schema.js';
import {
  STALE_RUN_MS,
  rescheduleAutomation,
  runAutomation,
  scheduledAutomationCount,
  startAutomationScheduler,
  stopAutomationScheduler,
  unscheduleAutomation,
  type AutomationJob,
} from '../../services/automation-scheduler.js';
import type { StartThreadInput } from '../../services/runner-thread-launcher.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedAutomation, seedProject, seedThread } from '../helpers/test-db.js';

const NEXT = new Date('2030-01-01T09:00:00.000Z');

/** Fake cron: records jobs by pattern and lets the test fire them. */
function fakeCron() {
  const live = new Map<string, { onTick: () => void; stopped: boolean }>();
  const createJob = (pattern: string, onTick: () => void): AutomationJob => {
    if (pattern === 'not a cron') throw new Error('invalid pattern');
    const entry = { onTick, stopped: false };
    live.set(pattern, entry);
    return {
      stop: () => {
        entry.stopped = true;
      },
      nextRun: () => NEXT,
    };
  };
  return { createJob, live };
}

/** Fake launcher. On success the real launcher registers the thread row, so seed it. */
function fakeLauncher(result: 'ok' | 'offline' = 'ok', register?: (threadId: string) => void) {
  const calls: StartThreadInput[] = [];
  const launch = async (input: StartThreadInput) => {
    calls.push(input);
    if (result === 'ok') register?.(`t-${calls.length}`);
    return result === 'ok'
      ? ok({ thread: { id: `t-${calls.length}` }, threadId: `t-${calls.length}`, runnerId: 'r1' })
      : err({
          kind: 'runner-unavailable' as const,
          status: 502 as const,
          message: 'No online runner found for this project',
        });
  };
  return { calls, launch: launch as any };
}

const ports = { requests: {} as any };

describe('automation scheduler', () => {
  let t: TestApp;
  const automation = (id: string) =>
    (t.db as any).select().from(schema.automations).where(eq(schema.automations.id, id)).get();
  const runs = () => (t.db as any).select().from(schema.automationRuns).all();
  const register = (id: string) =>
    seedThread(t.db as any, { id, projectId: 'p1', userId: 'alice' });

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(() => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'alice', path: '/repo' });
  });

  afterEach(() => stopAutomationScheduler());

  describe('scheduling', () => {
    test('schedules enabled automations only, and records nextRunAt', async () => {
      seedAutomation(t.db as any, { id: 'on', projectId: 'p1', schedule: '0 9 * * *' });
      seedAutomation(t.db as any, {
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
      seedAutomation(t.db as any, { id: 'on', projectId: 'p1', lastRunAt: '2020-01-01T00:00:00Z' });
      const launcher = fakeLauncher();

      await startAutomationScheduler({
        ports,
        createJob: fakeCron().createJob,
        launch: launcher.launch,
      });

      expect(launcher.calls).toEqual([]);
    });

    test('a tick starts a run for the automation owner', async () => {
      seedAutomation(t.db as any, {
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

    test('a tick for an automation disabled since scheduling does nothing', async () => {
      seedAutomation(t.db as any, { id: 'on', projectId: 'p1', schedule: '0 9 * * *' });
      const cron = fakeCron();
      const launcher = fakeLauncher();
      await startAutomationScheduler({ ports, createJob: cron.createJob, launch: launcher.launch });

      (t.db as any).update(schema.automations).set({ enabled: 0 }).run();
      cron.live.get('0 9 * * *')!.onTick();
      await Bun.sleep(20);

      expect(launcher.calls).toEqual([]);
    });

    test('reschedule follows a schedule change; disabling clears nextRunAt', async () => {
      seedAutomation(t.db as any, { id: 'a', projectId: 'p1', schedule: '0 9 * * *' });
      const cron = fakeCron();
      await startAutomationScheduler({
        ports,
        createJob: cron.createJob,
        launch: fakeLauncher().launch,
      });

      (t.db as any).update(schema.automations).set({ schedule: '0 18 * * *' }).run();
      await rescheduleAutomation('a');
      expect(cron.live.get('0 9 * * *')!.stopped).toBe(true);
      expect(cron.live.get('0 18 * * *')!.stopped).toBe(false);

      (t.db as any).update(schema.automations).set({ enabled: 0 }).run();
      await rescheduleAutomation('a');
      expect(cron.live.get('0 18 * * *')!.stopped).toBe(true);
      expect(automation('a').nextRunAt).toBeNull();
      expect(scheduledAutomationCount()).toBe(0);
    });

    test('unschedule stops a deleted automation from firing', async () => {
      seedAutomation(t.db as any, { id: 'a', projectId: 'p1', schedule: '0 9 * * *' });
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
      seedAutomation(t.db as any, { id: 'bad', projectId: 'p1', schedule: 'not a cron' });
      seedAutomation(t.db as any, { id: 'good', projectId: 'p1', schedule: '0 9 * * *' });

      await startAutomationScheduler({
        ports,
        createJob: fakeCron().createJob,
        launch: fakeLauncher().launch,
      });

      expect(scheduledAutomationCount()).toBe(1);
    });
  });

  describe('run bookkeeping', () => {
    test('a dispatched run is recorded as running and the thread is read-only', async () => {
      seedAutomation(t.db as any, { id: 'a', projectId: 'p1', userId: 'alice', prompt: 'look' });
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
      seedAutomation(t.db as any, { id: 'a', projectId: 'p1', userId: 'alice' });
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
      const placeholder = (t.db as any)
        .select()
        .from(schema.threads)
        .where(eq(schema.threads.id, run.threadId))
        .get();
      expect(placeholder).toMatchObject({ userId: 'alice', archived: 1, status: 'failed' });
    });

    test('runs stuck in running for over a day are failed on start', async () => {
      seedAutomation(t.db as any, { id: 'a', projectId: 'p1' });
      seedThread(t.db as any, { id: 'old', projectId: 'p1' });
      seedThread(t.db as any, { id: 'fresh', projectId: 'p1' });
      const at = (ms: number) => new Date(Date.now() - ms).toISOString();
      (t.db as any)
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
  });
});
