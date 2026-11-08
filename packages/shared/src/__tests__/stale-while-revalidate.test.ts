import { describe, expect, test } from 'bun:test';

import { err, ok, type Result } from 'neverthrow';

import { createStaleWhileRevalidate } from '../stale-while-revalidate.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(overrides: { refreshConcurrency?: number } = {}) {
  let clock = 0;
  const errors: unknown[] = [];
  const swr = createStaleWhileRevalidate<number, string>({
    freshMs: 100,
    maxStaleMs: 1_000,
    capacity: 10,
    refreshConcurrency: overrides.refreshConcurrency ?? 4,
    now: () => clock,
    onRefreshError: (_key, error) => errors.push(error),
  });
  return {
    swr,
    errors,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('createStaleWhileRevalidate', () => {
  test('concurrent cold reads share one lookup', async () => {
    const { swr } = setup();
    const gate = deferred<Result<number, string>>();
    let calls = 0;
    const lookup = () => {
      calls++;
      return gate.promise;
    };
    const reads = [swr.get('k', { lookup }), swr.get('k', { lookup }), swr.get('k', { lookup })];
    await flush();
    gate.resolve(ok(1));
    const results = await Promise.all(reads);
    expect(results.map((r) => r._unsafeUnwrap())).toEqual([1, 1, 1]);
    expect(calls).toBe(1);
  });

  test('a fresh value is served without a lookup', async () => {
    const { swr, advance } = setup();
    let calls = 0;
    const lookup = async () => ok(++calls);
    await swr.get('k', { lookup });
    advance(50);
    expect((await swr.get('k', { lookup }))._unsafeUnwrap()).toBe(1);
    expect(calls).toBe(1);
  });

  test('a stale value is served at once while one refresh runs in the background', async () => {
    const { swr, advance } = setup();
    await swr.get('k', { lookup: async () => ok(1) });
    advance(200);

    const slow = deferred<Result<number, string>>();
    let refreshes = 0;
    const changed: number[] = [];
    const lookup = () => {
      refreshes++;
      return slow.promise;
    };
    const onChanged = (v: number) => changed.push(v);

    // Neither read waits for the slow refresh.
    expect((await swr.get('k', { lookup, onChanged }))._unsafeUnwrap()).toBe(1);
    expect((await swr.get('k', { lookup, onChanged }))._unsafeUnwrap()).toBe(1);
    expect(refreshes).toBe(1);

    slow.resolve(ok(2));
    await flush();
    await flush();
    expect(changed).toEqual([2]);
    expect((await swr.get('k', { lookup, onChanged }))._unsafeUnwrap()).toBe(2);
  });

  test('a refresh that yields the same value does not report a change', async () => {
    const { swr, advance } = setup();
    await swr.get('k', { lookup: async () => ok(1) });
    advance(200);
    const changed: number[] = [];
    await swr.get('k', { lookup: async () => ok(1), onChanged: (v) => changed.push(v) });
    await flush();
    await flush();
    expect(changed).toEqual([]);
  });

  test('a failed refresh keeps serving the previous value', async () => {
    const { swr, advance, errors } = setup();
    await swr.get('k', { lookup: async () => ok(1) });
    advance(200);
    await swr.get('k', { lookup: async () => err('boom') });
    await flush();
    await flush();
    expect(errors).toEqual(['boom']);
    expect((await swr.get('k', { lookup: async () => err('boom') }))._unsafeUnwrap()).toBe(1);
  });

  test('a cold failure is returned and not cached', async () => {
    const { swr } = setup();
    expect((await swr.get('k', { lookup: async () => err('boom') }))._unsafeUnwrapErr()).toBe(
      'boom',
    );
    expect((await swr.get('k', { lookup: async () => ok(3) }))._unsafeUnwrap()).toBe(3);
  });

  test('a value older than maxStaleMs is never served', async () => {
    const { swr, advance } = setup();
    await swr.get('k', { lookup: async () => ok(1) });
    advance(2_000);
    expect((await swr.get('k', { lookup: async () => ok(2) }))._unsafeUnwrap()).toBe(2);
  });

  test('a version change forces the read to wait for a new value', async () => {
    const { swr } = setup();
    await swr.get('k', { lookup: async () => ok(1), version: 1 });
    expect((await swr.get('k', { lookup: async () => ok(2), version: 2 }))._unsafeUnwrap()).toBe(2);
  });

  test('invalidateWhere drops the value and a refresh in flight', async () => {
    const { swr, advance } = setup();
    await swr.get('p1|a', { lookup: async () => ok(1) });
    await swr.get('p2|a', { lookup: async () => ok(10) });
    advance(200);

    const slow = deferred<Result<number, string>>();
    const changed: number[] = [];
    await swr.get('p1|a', { lookup: () => slow.promise, onChanged: (v) => changed.push(v) });

    swr.invalidateWhere((key) => key.startsWith('p1|'));
    expect(swr.has('p1|a')).toBe(false);
    expect(swr.has('p2|a')).toBe(true);

    // The interrupted refresh resolving late must not reinsert its value.
    slow.resolve(ok(2));
    await flush();
    await flush();
    expect(changed).toEqual([]);
    expect(swr.has('p1|a')).toBe(false);
    expect((await swr.get('p1|a', { lookup: async () => ok(3) }))._unsafeUnwrap()).toBe(3);
  });

  test('bounds background refreshes across keys', async () => {
    const { swr, advance } = setup({ refreshConcurrency: 1 });
    await swr.get('a', { lookup: async () => ok(1) });
    await swr.get('b', { lookup: async () => ok(1) });
    advance(200);

    const gateA = deferred<Result<number, string>>();
    let startedB = false;
    await swr.get('a', { lookup: () => gateA.promise });
    await swr.get('b', {
      lookup: async () => {
        startedB = true;
        return ok(2);
      },
    });
    await flush();
    expect(startedB).toBe(false);

    gateA.resolve(ok(2));
    await flush();
    await flush();
    expect(startedB).toBe(true);
  });
});
