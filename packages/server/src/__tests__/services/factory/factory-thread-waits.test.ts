/**
 * A factory agent step's wait on its thread: the terminal signal wakes it
 * without waiting for the poll, a missing or stale thread fails the step, and a
 * stopped run ends the wait.
 */
import { describe, expect, test } from 'bun:test';

import {
  createThreadWaits,
  isWaitingOn,
  signalThreadTerminal,
  type ThreadRecord,
} from '../../../services/factory/factory-thread-waits.js';

const created = new Date(0).toISOString();

function waitsOver(record: { current: ThreadRecord | null }, now = () => 0) {
  return createThreadWaits({
    readThread: async () => record.current,
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
    const record = { current: { status: 'running', createdAt: created } as ThreadRecord | null };
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
    const record = {
      current: {
        status: 'completed',
        createdAt: created,
        completedAt: before,
      } as ThreadRecord | null,
    };
    const wait = waitsOver(record)('t4', new AbortController().signal, { completedAt: before });
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
});
