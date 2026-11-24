import { describe, expect, test } from 'bun:test';

import { err, ok } from 'neverthrow';

import { createActivityTracker, type ActivitySpec } from '../../services/activity-tracker.js';

type Report = { eventType: string; payload: any };

function setup(respond: (r: Report, n: number) => Promise<unknown> = async () => ({ ok: true })) {
  const reports: Report[] = [];
  const events: any[] = [];
  let n = 0;
  const tracker = createActivityTracker({
    reporter: {
      request: (eventType, payload) => {
        const r = { eventType, payload };
        reports.push(r);
        return respond(r, n++);
      },
    },
    emitToUser: (_userId, event) => events.push(event),
    retryTimes: 3,
    retryBaseMs: 1,
    newId: () => 'a1',
  });
  return { tracker, reports, events };
}

const SPEC = {
  kind: 'project.clone' as const,
  userId: 'u1',
  title: 'Clone o/r',
  input: { cloneUrl: 'https://github.com/o/r.git', destinationPath: '/tmp/r' },
};

describe('trackActivity', () => {
  test('an ok result reports succeeded with the recorded result', async () => {
    const { tracker, reports } = setup();
    const result = await tracker.trackActivity(SPEC, async (activity) => {
      activity.step('Cloning');
      activity.result({ projectId: 'p1' });
      return ok('done');
    });
    await tracker.flush();
    expect(result._unsafeUnwrap()).toBe('done');
    expect(reports.map((r) => r.eventType)).toEqual([
      'data:activity_start',
      'data:activity_update',
      'data:activity_update',
    ]);
    expect(reports[0].payload).toMatchObject({
      id: 'a1',
      kind: 'project.clone',
      title: 'Clone o/r',
    });
    expect(reports[1].payload).toEqual({ id: 'a1', patch: { step: 'Cloning' } });
    expect(reports[2].payload).toEqual({
      id: 'a1',
      patch: { status: 'succeeded', resultRef: { projectId: 'p1' } },
    });
    expect(tracker.liveIds()).toEqual([]);
  });

  test('an err result reports failed with its message', async () => {
    const { tracker, reports } = setup();
    const result = await tracker.trackActivity(SPEC, async () =>
      err(new Error('destination exists')),
    );
    await tracker.flush();
    expect(result.isErr()).toBe(true);
    expect(reports.at(-1)?.payload.patch).toEqual({
      status: 'failed',
      error: 'destination exists',
    });
  });

  test('a thrown exception reports failed and is rethrown', async () => {
    const { tracker, reports } = setup();
    await expect(
      tracker.trackActivity(SPEC, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await tracker.flush();
    expect(reports.at(-1)?.payload.patch).toEqual({ status: 'failed', error: 'boom' });
  });

  test('failureOf turns an ok value into a failed activity', async () => {
    const { tracker, reports } = setup();
    const result = await tracker.trackActivity(SPEC, async () => ok({ errors: ['bun install'] }), {
      failureOf: (v) => (v.errors.length ? `Setup failed: ${v.errors[0]}` : null),
    });
    await tracker.flush();
    expect(result.isOk()).toBe(true);
    expect(reports.at(-1)?.payload.patch).toEqual({
      status: 'failed',
      error: 'Setup failed: bun install',
    });
  });

  test('a refused or failed report does not fail the operation', async () => {
    const { tracker } = setup(async (r) => {
      if (r.eventType === 'data:activity_start') return { success: false, error: 'Forbidden' };
      throw new Error('offline');
    });
    const result = await tracker.trackActivity(SPEC, async (activity) => {
      activity.step('x');
      return ok(1);
    });
    await tracker.flush();
    expect(result._unsafeUnwrap()).toBe(1);
  });

  test('the terminal report is retried after a disconnect', async () => {
    const { tracker, reports } = setup(async (r, n) => {
      if (r.eventType === 'data:activity_update' && n < 3) throw new Error('disconnected');
      return { ok: true };
    });
    await tracker.trackActivity(SPEC, async () => ok(1));
    await tracker.flush();
    const terminal = reports.filter((r) => r.eventType === 'data:activity_update');
    expect(terminal.length).toBe(3);
    expect(terminal.every((r) => r.payload.patch.status === 'succeeded')).toBe(true);
  });

  test('a refused terminal report is not retried', async () => {
    const { tracker, reports } = setup(async (r) =>
      r.eventType === 'data:activity_update' ? { success: false, error: 'Forbidden' } : {},
    );
    await tracker.trackActivity(SPEC, async () => ok(1));
    await tracker.flush();
    expect(reports.filter((r) => r.eventType === 'data:activity_update').length).toBe(1);
  });

  test('stop ends the terminal retries', async () => {
    const tracker = createActivityTracker({
      reporter: {
        request: async (eventType) => {
          if (eventType === 'data:activity_update') throw new Error('down');
          return {};
        },
      },
      emitToUser: () => {},
      retryTimes: 1000,
      retryBaseMs: 50,
    });
    await tracker.trackActivity(SPEC, async () => ok(1));
    tracker.stop();
    await tracker.flush();
    expect(tracker.liveIds()).toEqual([]);
  });

  test('progress goes to the user, not to the server', async () => {
    const { tracker, reports, events } = setup();
    const activity = tracker.beginActivity(SPEC);
    activity.progress(42.4);
    expect(events).toEqual([
      { type: 'activity:progress', threadId: '', data: { id: 'a1', percent: 42 } },
    ]);
    activity.succeed();
    await tracker.flush();
    expect(reports.some((r) => JSON.stringify(r.payload).includes('42'))).toBe(false);
  });
});

describe('reconcile', () => {
  test('lists the activities in flight', async () => {
    const { tracker, reports } = setup();
    tracker.beginActivity({ ...SPEC, id: 'clone-1' });
    await tracker.reconcile();
    expect(reports.at(-1)).toEqual({
      eventType: 'data:activity_reconcile',
      payload: { liveIds: ['clone-1'] },
    });
  });

  test('sends an empty list after a restart', async () => {
    const { tracker, reports } = setup();
    await tracker.reconcile();
    expect(reports).toEqual([{ eventType: 'data:activity_reconcile', payload: { liveIds: [] } }]);
  });
});

describe('origin, effects and recordActivity (track-funny-actions)', () => {
  const CLEANUP: ActivitySpec = {
    kind: 'workspace.cleanup',
    userId: 'u1',
    projectId: 'p1',
    title: 'Clean up worktree',
    input: { reason: 'manual', deleteBranch: true },
    origin: 'implicit',
  };

  test('origin rides on the start; effects on the next report and the terminal one', async () => {
    const { tracker, reports } = setup();
    await tracker.trackActivity(CLEANUP, async (activity) => {
      activity.effect('command-stopped', 'dev');
      activity.step('Removing worktree');
      activity.effect('worktree-removed', '/w');
      return ok(undefined);
    });
    await tracker.flush();
    expect(reports[0].payload.origin).toBe('implicit');
    expect(reports[1].payload.patch).toEqual({
      step: 'Removing worktree',
      effects: [{ effect: 'command-stopped', target: 'dev' }],
    });
    expect(reports[2].payload.patch).toEqual({
      status: 'succeeded',
      effects: [
        { effect: 'command-stopped', target: 'dev' },
        { effect: 'worktree-removed', target: '/w' },
      ],
    });
  });

  test('the origin defaults to user', async () => {
    const { tracker, reports } = setup();
    await tracker.trackActivity(SPEC, async () => ok(undefined));
    await tracker.flush();
    expect(reports[0].payload.origin).toBe('user');
  });

  test('recordActivity writes one finished start and does not join the live set', async () => {
    const { tracker, reports } = setup();
    const pending = tracker.recordActivity(CLEANUP, {
      ok: false,
      error: 'branch is checked out',
      effects: [{ effect: 'worktree-removed', target: '/w' }],
    });
    expect(tracker.liveIds()).toEqual([]);
    await pending;
    expect(reports).toHaveLength(1);
    expect(reports[0].eventType).toBe('data:activity_start');
    expect(reports[0].payload).toMatchObject({
      status: 'failed',
      error: 'branch is checked out',
      origin: 'implicit',
      effects: [{ effect: 'worktree-removed', target: '/w' }],
    });
  });

  test('recordActivity is retried while disconnected', async () => {
    const { tracker, reports } = setup(async (_r, n) => {
      if (n < 2) throw new Error('disconnected');
      return { ok: true };
    });
    await tracker.recordActivity(CLEANUP, { ok: true });
    expect(reports).toHaveLength(3);
  });

  test('a successful on-failure kind sends nothing', async () => {
    const { tracker, reports } = setup();
    const WAKE = { kind: 'sandbox.wake' as const, userId: 'u1', title: 'Wake', input: {} };
    await tracker.recordActivity(WAKE, { ok: true });
    expect(reports).toHaveLength(0);
    await tracker.recordActivity(WAKE, { ok: false, error: 'lost' });
    expect(reports).toHaveLength(1);
  });
});
