import { describe, expect, test } from 'bun:test';

import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import {
  createSandboxIdleSweeper,
  isIdle,
  type IdleCandidate,
} from '../../../services/thread-sandboxes/idle-sweeper.js';
import { createSandboxWaker } from '../../../services/thread-sandboxes/sandbox-lifecycle.js';
import type { ProvisionError } from '../../../services/thread-sandboxes/thread-sandbox-service.js';
import type {
  ThreadSandboxRow,
  ThreadSandboxState,
} from '../../../services/thread-sandboxes/thread-sandbox-store.js';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const IDLE_MS = 10 * 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const candidate = (patch: Partial<IdleCandidate> = {}): IdleCandidate => ({
  threadId: 't1',
  threadStatus: 'completed',
  threadUpdatedAt: ago(IDLE_MS + 1),
  sandboxUpdatedAt: ago(IDLE_MS + 1),
  ...patch,
});

describe('isIdle', () => {
  test('a finished thread untouched for the idle window is idle', () => {
    expect(isIdle(candidate(), NOW, IDLE_MS)).toBe(true);
  });

  test('an active thread is never idle, however old', () => {
    for (const status of ['pending', 'running', 'waiting']) {
      expect(
        isIdle(
          candidate({ threadStatus: status, threadUpdatedAt: ago(IDLE_MS * 10) }),
          NOW,
          IDLE_MS,
        ),
      ).toBe(false);
    }
  });

  test('recent activity on the thread or the sandbox keeps it awake', () => {
    expect(isIdle(candidate({ threadUpdatedAt: ago(1_000) }), NOW, IDLE_MS)).toBe(false);
    expect(isIdle(candidate({ sandboxUpdatedAt: ago(1_000) }), NOW, IDLE_MS)).toBe(false);
  });

  test('a sandbox whose thread row is gone is idle once its own window passes', () => {
    expect(isIdle(candidate({ threadStatus: null, threadUpdatedAt: null }), NOW, IDLE_MS)).toBe(
      true,
    );
  });
});

describe('createSandboxIdleSweeper', () => {
  test('stops only idle sandboxes and keeps going after a failure', async () => {
    const stopCalls: string[] = [];
    const sweeper = createSandboxIdleSweeper({
      idleMs: IDLE_MS,
      now: () => NOW,
      listRunning: () =>
        okAsync([
          candidate({ threadId: 'idle-fails' }),
          candidate({ threadId: 'busy', threadStatus: 'running' }),
          candidate({ threadId: 'idle-ok' }),
        ]),
      control: {
        stop: (threadId: string) => {
          stopCalls.push(threadId);
          return threadId === 'idle-fails'
            ? errAsync<ThreadSandboxState, ProvisionError>({ kind: 'storage', message: 'boom' })
            : okAsync<ThreadSandboxState, ProvisionError>('stopped');
        },
      },
    });

    expect(await sweeper.sweep()).toEqual(['idle-ok']);
    expect(stopCalls).toEqual(['idle-fails', 'idle-ok']);
  });

  test('a listing failure stops nothing', async () => {
    let stopped = 0;
    const sweeper = createSandboxIdleSweeper({
      listRunning: () => errAsync('db down'),
      control: {
        stop: () => {
          stopped++;
          return okAsync<ThreadSandboxState, ProvisionError>('stopped');
        },
      },
    });
    expect(await sweeper.sweep()).toEqual([]);
    expect(stopped).toBe(0);
  });
});

describe('createSandboxWaker', () => {
  const row = (patch: Partial<ThreadSandboxRow> = {}): ThreadSandboxRow => ({
    threadId: 't1',
    userId: 'owner',
    connectionId: 'c1',
    provider: 'fake',
    sandboxId: 'sb1',
    runnerId: 'r1',
    sizeId: 'small',
    state: 'stopped',
    error: null,
    generation: 0,
    createdAt: ago(0),
    updatedAt: ago(0),
    ...patch,
  });

  function setup(current: ThreadSandboxRow | null) {
    const resumes: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const waker = createSandboxWaker({
      store: { get: () => okAsync(current) },
      control: {
        resume: (threadId: string) => {
          resumes.push(threadId);
          return ResultAsync.fromSafePromise(gate.then(() => 'r1'));
        },
      },
    });
    return { waker, resumes, release };
  }

  test('resumes the owner’s stopped sandbox; concurrent wakes share one resume', async () => {
    const { waker, resumes, release } = setup(row());
    const a = waker.wake('t1', 'owner');
    const b = waker.wake('t1', 'owner');
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra._unsafeUnwrap()).toBe('r1');
    expect(rb._unsafeUnwrap()).toBe('r1');
    expect(resumes).toEqual(['t1']);
  });

  test('a settled wake does not block the next one', async () => {
    const { waker, resumes, release } = setup(row());
    release();
    await waker.wake('t1', 'owner');
    await waker.wake('t1', 'owner');
    expect(resumes).toEqual(['t1', 't1']);
  });

  test('never wakes another user’s sandbox', async () => {
    const { waker, resumes } = setup(row());
    expect((await waker.wake('t1', 'intruder')).isErr()).toBe(true);
    expect(resumes).toEqual([]);
  });

  test('never wakes a sandbox that is not stopped', async () => {
    for (const state of ['running', 'lost', 'failed', 'provisioning']) {
      const { waker, resumes } = setup(row({ state }));
      expect((await waker.wake('t1', 'owner')).isErr()).toBe(true);
      expect(resumes).toEqual([]);
    }
    const { waker } = setup(null);
    expect((await waker.wake('t1', 'owner')).isErr()).toBe(true);
  });
});
