/**
 * A factory agent step's wait on its thread: the terminal signal wakes it
 * without waiting for the poll, a missing or stale thread fails the step, and a
 * stopped run ends the wait.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import {
  createThreadWaits,
  isWaitingOn,
  signalThreadTerminal,
  WAKE_GRACE_MS,
  type ThreadActivity,
  type ThreadRecord,
  type WakeSource,
} from '../../../services/factory/factory-thread-waits.js';
import {
  createTestDb,
  seedMessage,
  seedMessageQueue,
  seedProject,
  seedThread,
} from '../../helpers/test-db.js';

const created = new Date(0).toISOString();

/** The thread row a wait reads, swapped by the test. */
interface RecordSlot {
  current: ThreadRecord | null;
}

function waitsOver(
  record: { current: ThreadRecord | null },
  now = () => 0,
  wakes: { current: WakeSource[] } = { current: [] },
  pendingInput: { current: boolean } = { current: false },
) {
  return createThreadWaits({
    readThread: async () => record.current,
    readWakeSources: async () => wakes.current,
    readPendingInput: async () => pendingInput.current,
    readOutput: async () => 'summary',
    // A poll that never elapses on its own: only a signal or a stop wakes it.
    sleep: (_ms, signal) =>
      new Promise((_resolve, reject) =>
        signal?.addEventListener('abort', () => reject(new Error())),
      ),
    now,
  });
}

describe('factory thread waits', () => {
  test('the terminal signal resumes the step with the persisted status', async () => {
    const record: RecordSlot = { current: { status: 'running', createdAt: created } };
    const wait = waitsOver(record)('t1', new AbortController().signal);
    await Bun.sleep(1);
    expect(isWaitingOn('t1')).toBe(true);

    record.current = { status: 'completed', createdAt: created };
    signalThreadTerminal('t1');

    expect(await wait).toEqual({ status: 'completed', output: 'summary' });
    expect(isWaitingOn('t1')).toBe(false);
  });

  test('a follow-up counts as done only once the thread finishes again', async () => {
    const before = '2026-11-16T10:00:00.000Z';
    // Still showing the previous run's completion: the follow-up has not run yet.
    const record: RecordSlot = {
      current: {
        status: 'completed',
        createdAt: created,
        completedAt: before,
      },
    };
    const wait = waitsOver(record)('t4', new AbortController().signal, {
      completedAt: before,
      sentAt: before,
    });
    await Bun.sleep(1);
    expect(isWaitingOn('t4')).toBe(true);

    record.current = {
      status: 'completed',
      createdAt: created,
      completedAt: '2026-11-16T10:05:00.000Z',
    };
    signalThreadTerminal('t4');

    expect((await wait).status).toBe('completed');
  });

  test('a follow-up on a thread that finished days ago is not stale at once', async () => {
    const daysAgo = new Date(0).toISOString();
    const sentAt = new Date(5 * 24 * 60 * 60 * 1000).toISOString();
    const record: RecordSlot = {
      current: { status: 'running', createdAt: daysAgo, completedAt: null },
    };
    const controller = new AbortController();
    // "Now" is a minute after the follow-up was sent, days after the last finish.
    const wait = waitsOver(record, () => Date.parse(sentAt) + 60_000)('t5', controller.signal, {
      completedAt: daysAgo,
      sentAt,
    });
    await Bun.sleep(1);
    expect(isWaitingOn('t5')).toBe(true);
    controller.abort();
    expect((await wait).status).toBe('cancelled');
  });

  test('a finished turn with a background job still running is not a finished agent', async () => {
    // Issue #229: the agent ended its turn to wait for its test job. Moving on
    // then found no commit and removed the checkout with its uncommitted work.
    const finishedAt = new Date(1_000).toISOString();
    const record: RecordSlot = {
      current: { status: 'completed', createdAt: created, completedAt: finishedAt },
    };
    const wakes = { current: [{ live: true, updatedAt: created }] };
    let settled = false;
    const wait = waitsOver(
      record,
      () => 5_000,
      wakes,
    )('t-job', new AbortController().signal).then((outcome) => {
      settled = true;
      return outcome;
    });
    await Bun.sleep(1);
    expect(settled).toBe(false);

    // The job ended and woke the agent, which runs and finishes again.
    wakes.current = [{ live: false, updatedAt: new Date(6_000).toISOString() }];
    record.current = { status: 'running', createdAt: created, completedAt: finishedAt };
    signalThreadTerminal('t-job');
    await Bun.sleep(1);
    expect(settled).toBe(false);

    record.current = {
      status: 'completed',
      createdAt: created,
      completedAt: new Date(9_000).toISOString(),
    };
    signalThreadTerminal('t-job');
    expect((await wait).status).toBe('completed');
  });

  test('a job that just ended holds the step while its wake starts, but not forever', async () => {
    const record: RecordSlot = {
      current: {
        status: 'completed',
        createdAt: created,
        completedAt: new Date(1_000).toISOString(),
      },
    };
    const wakes = { current: [{ live: false, updatedAt: new Date(2_000).toISOString() }] };
    let clock = 3_000;
    let settled = false;
    const wait = waitsOver(
      record,
      () => clock,
      wakes,
    )('t-woke', new AbortController().signal).then((outcome) => {
      settled = true;
      return outcome;
    });
    await Bun.sleep(1);
    expect(settled).toBe(false);

    // The wake never started the agent: after the grace the turn stands.
    clock = 2_000 + WAKE_GRACE_MS;
    signalThreadTerminal('t-woke');
    expect((await wait).status).toBe('completed');
  });

  test('a job that ended before the turn finished does not hold the step', async () => {
    const record = {
      current: {
        status: 'completed',
        createdAt: created,
        completedAt: new Date(5_000).toISOString(),
      },
    };
    const wakes = { current: [{ live: false, updatedAt: new Date(4_000).toISOString() }] };
    const outcome = await waitsOver(
      record,
      () => 5_500,
      wakes,
    )('t-old-job', new AbortController().signal);
    expect(outcome.status).toBe('completed');
  });

  test('a follow-up queued behind a running turn is not settled by that turn ending', async () => {
    // #449: the factory sent the implement prompt again while the agent ran;
    // it waited in the queue, and the running turn's end was taken for its end.
    const finishedAt = new Date(9_000).toISOString();
    const record: RecordSlot = {
      current: { status: 'completed', createdAt: created, completedAt: finishedAt },
    };
    const pending = { current: true };
    let settled = false;
    const wait = waitsOver(
      record,
      () => 9_500,
      { current: [] },
      pending,
    )('t-queued', new AbortController().signal, { completedAt: null, sentAt: created }).then(
      (outcome) => {
        settled = true;
        return outcome;
      },
    );
    await Bun.sleep(1);
    expect(settled).toBe(false);

    // The queue hands the follow-up over: the agent runs it, then finishes.
    pending.current = false;
    record.current = { status: 'running', createdAt: created, completedAt: finishedAt };
    signalThreadTerminal('t-queued');
    await Bun.sleep(1);
    expect(settled).toBe(false);

    record.current = {
      status: 'completed',
      createdAt: created,
      completedAt: new Date(20_000).toISOString(),
    };
    signalThreadTerminal('t-queued');
    expect((await wait).status).toBe('completed');
  });

  test('an unanswered message holds the step only within the grace after the finish', async () => {
    const record = {
      current: {
        status: 'completed',
        createdAt: created,
        completedAt: new Date(1_000).toISOString(),
      },
    };
    const outcome = await waitsOver(
      record,
      () => 1_000 + WAKE_GRACE_MS,
      { current: [] },
      { current: true },
    )('t-stuck-queue', new AbortController().signal);
    expect(outcome.status).toBe('completed');
  });

  test('a stopped thread is settled even with a job still running', async () => {
    const record = { current: { status: 'stopped', createdAt: created, completedAt: created } };
    const wakes = { current: [{ live: true, updatedAt: created }] };
    const outcome = await waitsOver(
      record,
      () => 0,
      wakes,
    )('t-stopped', new AbortController().signal);
    expect(outcome.status).toBe('stopped');
  });

  test('a thread that no longer exists fails the step', async () => {
    const outcome = await waitsOver({ current: null })('gone', new AbortController().signal);
    expect(outcome.status).toBe('missing');
  });

  test('a thread running past the stale limit fails the step', async () => {
    const record = { current: { status: 'running', createdAt: created } };
    const outcome = await waitsOver(record, () => 25 * 60 * 60 * 1000)(
      't2',
      new AbortController().signal,
    );
    expect(outcome.status).toBe('stale');
  });

  test('stopping the run ends the wait', async () => {
    const controller = new AbortController();
    const wait = waitsOver({ current: { status: 'running', createdAt: created } })(
      't3',
      controller.signal,
    );
    await Bun.sleep(1);
    controller.abort();
    expect((await wait).status).toBe('cancelled');
  });

  describe('an answer left in a turn that never ended', () => {
    const QUIET_MS = 10 * 60 * 1000;
    const answeredAt = new Date(60_000).toISOString();

    /** A waiter that reports quiet answers, over a running thread and its newest message. */
    function quietWaits(activity: { current: ThreadActivity | null }, clock: { now: number }) {
      return createThreadWaits({
        readThread: async () => ({ status: 'running', createdAt: created }),
        readWakeSources: async () => [],
        readOutput: async () => 'the verdict',
        readActivity: async () => activity.current,
        quietAnswerMs: QUIET_MS,
        sleep: (_ms, signal) =>
          new Promise((_resolve, reject) =>
            signal?.addEventListener('abort', () => reject(new Error())),
          ),
        now: () => clock.now,
      });
    }

    test('is reported idle with the answer once it stayed quiet past the limit', async () => {
      // Seen in run 51eb478c: the reviewer wrote its verdict, but a bare
      // `wait` in its sandboxed shell kept the CLI's turn open, and the
      // thread stayed running until someone killed the shell.
      const activity = { current: { messageId: 'm1', at: answeredAt, answered: true } };
      const clock = { now: Date.parse(answeredAt) + 60_000 };
      const wait = quietWaits(activity, clock)('t-quiet', new AbortController().signal);
      await Bun.sleep(1);
      expect(isWaitingOn('t-quiet')).toBe(true);

      clock.now = Date.parse(answeredAt) + QUIET_MS + 1;
      signalThreadTerminal('t-quiet');
      expect(await wait).toMatchObject({ status: 'idle', output: 'the verdict' });
    });

    test('a step still in progress is not an answer, however long it takes', async () => {
      // A long tool call: the newest message is the one that called it.
      const activity = { current: { messageId: 'm1', at: answeredAt, answered: false } };
      const clock = { now: Date.parse(answeredAt) + 2 * QUIET_MS };
      const controller = new AbortController();
      const wait = quietWaits(activity, clock)('t-tool', controller.signal);
      await Bun.sleep(1);
      expect(isWaitingOn('t-tool')).toBe(true);
      controller.abort();
      expect((await wait).status).toBe('cancelled');
    });

    test("on a follow-up, the previous answer is not the follow-up's", async () => {
      const activity = { current: { messageId: 'old', at: answeredAt, answered: true } };
      const clock = { now: Date.parse(answeredAt) + 2 * QUIET_MS };
      const wait = quietWaits(activity, clock)('t-again', new AbortController().signal, {
        completedAt: created,
        sentAt: new Date(clock.now).toISOString(),
      });
      await Bun.sleep(1);
      expect(isWaitingOn('t-again')).toBe(true);

      const newAt = new Date(clock.now).toISOString();
      activity.current = { messageId: 'new', at: newAt, answered: true };
      clock.now += QUIET_MS + 1;
      signalThreadTerminal('t-again');
      expect((await wait).status).toBe('idle');
    });

    test('a waiter without the limit keeps waiting', async () => {
      const record: RecordSlot = { current: { status: 'running', createdAt: created } };
      const controller = new AbortController();
      const wait = waitsOver(record, () => 2 * QUIET_MS)('t-off', controller.signal);
      await Bun.sleep(1);
      expect(isWaitingOn('t-off')).toBe(true);
      controller.abort();
      expect((await wait).status).toBe('cancelled');
    });
  });
});

describe('factory thread waits over the database', () => {
  const finishedAt = '2026-11-24T07:09:08.975Z';
  let testDb: ReturnType<typeof createTestDb>;

  beforeEach(async () => {
    testDb = createTestDb();
    const { setConnection } = await import('../../../db/index.js');
    setConnection({
      db: testDb.db,
      schema: testDb.schema,
      sqlite: testDb.sqlite,
      mode: 'sqlite',
      close: async () => testDb.sqlite.close(),
    });
    seedProject(testDb.db, { id: 'p1', userId: 'alice' });
    seedThread(testDb.db, {
      id: 't1',
      projectId: 'p1',
      userId: 'alice',
      status: 'completed',
      completedAt: finishedAt,
    });
  });

  /** One look at the thread: settled, or still held (`null`). */
  async function settles(): Promise<string | null> {
    const controller = new AbortController();
    const waits = createThreadWaits({
      now: () => Date.parse(finishedAt) + 1_000,
      sleep: async () => controller.abort(),
    });
    const outcome = await waits('t1', controller.signal);
    return outcome.status === 'cancelled' ? null : outcome.status;
  }

  test('a message still in the queue holds a finished thread', async () => {
    seedMessageQueue(testDb.db, { threadId: 't1' });
    expect(await settles()).toBeNull();
  });

  test('a user message newer than the finish holds a finished thread', async () => {
    seedMessage(testDb.db, { threadId: 't1', timestamp: '2026-11-24T07:09:09.112Z' });
    expect(await settles()).toBeNull();
  });

  test('a thread with every message answered is settled', async () => {
    seedMessage(testDb.db, { threadId: 't1', timestamp: '2026-11-24T07:01:32.782Z' });
    expect(await settles()).toBe('completed');
  });
});
