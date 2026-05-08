import type { ThreadEvent as DomainThreadEvent, ThreadWithMessages } from '@funny/shared';
import { describe, test, expect, vi } from 'vitest';
import { createActor, fromPromise, waitFor } from 'xstate';

import { threadDataMachine, type ThreadDataSnapshot } from '@/machines/thread-data-machine';

function snapshot(thread: Partial<ThreadWithMessages> = {}): ThreadDataSnapshot {
  return {
    thread: {
      id: 't1',
      projectId: 'p1',
      title: 'thread',
      status: 'completed',
      messages: [],
      ...thread,
    } as ThreadWithMessages,
    events: [] as DomainThreadEvent[],
  };
}

/** Create an actor whose fetcher resolves with the given snapshot. */
function makeOkActor(data: ThreadDataSnapshot, fetchSpy = vi.fn()) {
  const machine = threadDataMachine.provide({
    actors: {
      fetcher: fromPromise<ThreadDataSnapshot, { threadId: string }>(async ({ input }) => {
        fetchSpy(input.threadId);
        return data;
      }),
    },
  });
  return { actor: createActor(machine, { input: { threadId: 't1' } }), fetchSpy };
}

/** Create an actor whose fetcher rejects. */
function makeFailActor(err: Error) {
  const machine = threadDataMachine.provide({
    actors: {
      fetcher: fromPromise<ThreadDataSnapshot, { threadId: string }>(async () => {
        throw err;
      }),
    },
  });
  return createActor(machine, { input: { threadId: 't1' } });
}

/** Create an actor whose fetcher resolves only when the returned trigger is called. */
function makeDeferredActor() {
  let resolve!: (data: ThreadDataSnapshot) => void;
  let reject!: (err: Error) => void;
  const fetchSpy = vi.fn();
  const promise = new Promise<ThreadDataSnapshot>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const machine = threadDataMachine.provide({
    actors: {
      fetcher: fromPromise<ThreadDataSnapshot, { threadId: string }>(async ({ input }) => {
        fetchSpy(input.threadId);
        return promise;
      }),
    },
  });
  return {
    actor: createActor(machine, { input: { threadId: 't1' } }),
    resolve,
    reject,
    fetchSpy,
  };
}

describe('threadDataMachine', () => {
  describe('initial state', () => {
    test('starts in unloaded with empty context', () => {
      const { actor } = makeOkActor(snapshot());
      actor.start();
      const snap = actor.getSnapshot();
      expect(snap.value).toBe('unloaded');
      expect(snap.context.threadId).toBe('t1');
      expect(snap.context.data).toBeNull();
      expect(snap.context.error).toBeNull();
      actor.stop();
    });
  });

  describe('unloaded → fetching', () => {
    test('LOAD transitions to fetching', () => {
      const { actor } = makeDeferredActor();
      actor.start();
      actor.send({ type: 'LOAD' });
      expect(actor.getSnapshot().value).toBe('fetching');
      actor.stop();
    });

    test('PREFETCH transitions to fetching', () => {
      const { actor } = makeDeferredActor();
      actor.start();
      actor.send({ type: 'PREFETCH' });
      expect(actor.getSnapshot().value).toBe('fetching');
      actor.stop();
    });
  });

  describe('fetching → loaded', () => {
    test('populates context.data with fetched snapshot', async () => {
      const data = snapshot({ id: 't1', title: 'loaded thread' });
      const { actor } = makeOkActor(data);
      actor.start();
      actor.send({ type: 'LOAD' });
      const final = await waitFor(actor, (s) => s.matches('loaded'), { timeout: 1000 });
      expect(final.context.data).toEqual(data);
      expect(final.context.error).toBeNull();
      actor.stop();
    });

    test('passes threadId to fetcher input', async () => {
      const { actor, fetchSpy } = makeOkActor(snapshot());
      actor.start();
      actor.send({ type: 'LOAD' });
      await waitFor(actor, (s) => s.matches('loaded'), { timeout: 1000 });
      expect(fetchSpy).toHaveBeenCalledWith('t1');
      actor.stop();
    });
  });

  describe('fetching → failed', () => {
    test('populates context.error and clears data on rejection', async () => {
      const actor = makeFailActor(new Error('network down'));
      actor.start();
      actor.send({ type: 'LOAD' });
      const final = await waitFor(actor, (s) => s.matches('failed'), { timeout: 1000 });
      expect(final.context.data).toBeNull();
      expect(final.context.error).toContain('network down');
      actor.stop();
    });
  });

  describe('INVALIDATE', () => {
    test('fetching → unloaded resets data/error', () => {
      const { actor } = makeDeferredActor();
      actor.start();
      actor.send({ type: 'LOAD' });
      expect(actor.getSnapshot().value).toBe('fetching');
      actor.send({ type: 'INVALIDATE' });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe('unloaded');
      expect(snap.context.data).toBeNull();
      expect(snap.context.error).toBeNull();
      actor.stop();
    });

    test('loaded → unloaded clears cached data', async () => {
      const { actor } = makeOkActor(snapshot());
      actor.start();
      actor.send({ type: 'LOAD' });
      await waitFor(actor, (s) => s.matches('loaded'), { timeout: 1000 });
      actor.send({ type: 'INVALIDATE' });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe('unloaded');
      expect(snap.context.data).toBeNull();
      actor.stop();
    });

    test('failed → unloaded clears error', async () => {
      const actor = makeFailActor(new Error('oops'));
      actor.start();
      actor.send({ type: 'LOAD' });
      await waitFor(actor, (s) => s.matches('failed'), { timeout: 1000 });
      actor.send({ type: 'INVALIDATE' });
      const snap = actor.getSnapshot();
      expect(snap.value).toBe('unloaded');
      expect(snap.context.error).toBeNull();
      actor.stop();
    });
  });

  describe('failed → fetching', () => {
    test('RETRY re-enters fetching', async () => {
      // fetcher fails first call, succeeds second
      let calls = 0;
      const data = snapshot();
      const machine = threadDataMachine.provide({
        actors: {
          fetcher: fromPromise<ThreadDataSnapshot, { threadId: string }>(async () => {
            calls += 1;
            if (calls === 1) throw new Error('first failure');
            return data;
          }),
        },
      });
      const actor = createActor(machine, { input: { threadId: 't1' } });
      actor.start();
      actor.send({ type: 'LOAD' });
      await waitFor(actor, (s) => s.matches('failed'), { timeout: 1000 });
      actor.send({ type: 'RETRY' });
      expect(actor.getSnapshot().value).toBe('fetching');
      const final = await waitFor(actor, (s) => s.matches('loaded'), { timeout: 1000 });
      expect(final.context.data).toEqual(data);
      expect(calls).toBe(2);
      actor.stop();
    });

    test('LOAD from failed re-enters fetching', async () => {
      const actor = makeFailActor(new Error('boom'));
      actor.start();
      actor.send({ type: 'LOAD' });
      await waitFor(actor, (s) => s.matches('failed'), { timeout: 1000 });
      actor.send({ type: 'LOAD' });
      expect(actor.getSnapshot().value).toBe('fetching');
      actor.stop();
    });

    test('PREFETCH from failed re-enters fetching', async () => {
      const actor = makeFailActor(new Error('boom'));
      actor.start();
      actor.send({ type: 'LOAD' });
      await waitFor(actor, (s) => s.matches('failed'), { timeout: 1000 });
      actor.send({ type: 'PREFETCH' });
      expect(actor.getSnapshot().value).toBe('fetching');
      actor.stop();
    });
  });

  describe('coalescing', () => {
    test('PREFETCH followed by LOAD while fetching does not trigger second request', async () => {
      const { actor, resolve, fetchSpy } = makeDeferredActor();
      actor.start();
      actor.send({ type: 'PREFETCH' });
      actor.send({ type: 'LOAD' });
      actor.send({ type: 'LOAD' });
      expect(actor.getSnapshot().value).toBe('fetching');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      resolve(snapshot());
      await waitFor(actor, (s) => s.matches('loaded'), { timeout: 1000 });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      actor.stop();
    });

    test('LOAD while loaded is a no-op (does not re-fetch)', async () => {
      const { actor, fetchSpy } = makeOkActor(snapshot());
      actor.start();
      actor.send({ type: 'LOAD' });
      await waitFor(actor, (s) => s.matches('loaded'), { timeout: 1000 });
      actor.send({ type: 'LOAD' });
      expect(actor.getSnapshot().value).toBe('loaded');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      actor.stop();
    });
  });
});
