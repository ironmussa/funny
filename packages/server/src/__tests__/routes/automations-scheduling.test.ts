/**
 * /api/automations writes keep the server scheduler in sync, and manual
 * triggers dispatch to the owner's runner through it.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import { err, ok } from 'neverthrow';

import {
  scheduledAutomationCount,
  startAutomationScheduler,
  stopAutomationScheduler,
} from '../../services/automation-scheduler.js';
import type { StartThreadInput } from '../../services/runner-thread-launcher.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { seedAutomation, seedProject, seedThread } from '../helpers/test-db.js';

describe('automation routes ↔ scheduler', () => {
  let t: TestApp;
  let launches: StartThreadInput[];
  let runnerOnline: boolean;

  const createJob = () => ({ stop() {}, nextRun: () => null });

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    t.cleanup();
    seedProject(t.db as any, { id: 'p1', userId: 'user-1', path: '/tmp/p1' });
    seedProject(t.db as any, { id: 'p2', userId: 'user-2', path: '/tmp/p2' });
    launches = [];
    runnerOnline = true;
    await startAutomationScheduler({
      ports: { requests: {} as any },
      createJob,
      launch: (async (input: StartThreadInput) => {
        launches.push(input);
        if (!runnerOnline) {
          return err({ kind: 'runner-unavailable', status: 502, message: 'No online runner' });
        }
        const threadId = `t-${launches.length}`;
        seedThread(t.db as any, { id: threadId, projectId: 'p1', userId: input.userId });
        return ok({ thread: { id: threadId }, threadId, runnerId: 'r1' });
      }) as any,
    });
  });

  afterEach(() => stopAutomationScheduler());

  test('creating an automation schedules it; disabling and deleting unschedule it', async () => {
    const res = await t.requestAs('user-1').post('/api/automations', {
      projectId: 'p1',
      name: 'Nightly',
      prompt: 'look',
      schedule: '0 9 * * *',
    });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(scheduledAutomationCount()).toBe(1);

    await t.requestAs('user-1').patch(`/api/automations/${id}`, { enabled: false });
    expect(scheduledAutomationCount()).toBe(0);

    await t.requestAs('user-1').patch(`/api/automations/${id}`, { enabled: true });
    expect(scheduledAutomationCount()).toBe(1);

    await t.requestAs('user-1').delete(`/api/automations/${id}`);
    expect(scheduledAutomationCount()).toBe(0);
  });

  test('creating an automation on a project the caller cannot see → 404', async () => {
    const res = await t.requestAs('user-1').post('/api/automations', {
      projectId: 'p2',
      name: 'Snoop',
      prompt: 'look',
      schedule: '0 9 * * *',
    });

    expect(res.status).toBe(404);
    expect(scheduledAutomationCount()).toBe(0);
  });

  test("the owner's manual trigger starts a run on their runner", async () => {
    seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1', enabled: 0 });

    const res = await t.requestAs('user-1').post('/api/automations/a1/trigger', {});

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, threadId: 't-1' });
    expect(launches.map((l) => l.userId)).toEqual(['user-1']);
  });

  test('another user triggering it → 404 and no dispatch', async () => {
    seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });

    const res = await t.requestAs('user-2').post('/api/automations/a1/trigger', {});

    expect(res.status).toBe(404);
    expect(launches).toEqual([]);
  });

  test('owner runner unavailable → 502, and the failed run is in the history', async () => {
    seedAutomation(t.db as any, { id: 'a1', projectId: 'p1', userId: 'user-1' });
    runnerOnline = false;

    const res = await t.requestAs('user-1').post('/api/automations/a1/trigger', {});

    expect(res.status).toBe(502);
    const runs = await (await t.requestAs('user-1').get('/api/automations/a1/runs')).json();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
  });
});
