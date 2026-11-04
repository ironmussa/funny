import { errAsync, okAsync } from 'neverthrow';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createDataLayer, layerRequestSignal } from '@/data/data-layer';
import { DataRequestError, toDomainError, unwrapResult } from '@/data/query-client';
import { getDataLayer, setDataLayerSession } from '@/data/runtime';

import { deferred, installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

afterEach(() => resetTestDataLayer());

describe('query client', () => {
  test('two concurrent fetches with the same key issue one request', async () => {
    const layer = installTestDataLayer();
    const gate = deferred<string[]>();
    const queryFn = vi.fn(() => gate.promise);

    const a = layer.queryClient.fetchQuery({ queryKey: ['runners'], queryFn });
    const b = layer.queryClient.fetchQuery({ queryKey: ['runners'], queryFn });
    gate.resolve(['r1']);

    await expect(Promise.all([a, b])).resolves.toEqual([['r1'], ['r1']]);
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  test('a fresh query is served from cache; a forced one refetches', async () => {
    const layer = installTestDataLayer();
    const queryFn = vi.fn(async () => ['r1']);

    await layer.queryClient.fetchQuery({ queryKey: ['runners'], queryFn });
    await layer.queryClient.fetchQuery({ queryKey: ['runners'], queryFn });
    expect(queryFn).toHaveBeenCalledTimes(1);

    await layer.queryClient.fetchQuery({ queryKey: ['runners'], queryFn, staleTime: 0 });
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  test('unwrapResult bridges neverthrow results to query-core and back', async () => {
    await expect(unwrapResult(okAsync(1))).resolves.toBe(1);
    const failure = unwrapResult(errAsync({ type: 'NOT_FOUND', message: 'gone' } as const));
    await expect(failure).rejects.toBeInstanceOf(DataRequestError);
    const error = await failure.catch((e) => e);
    expect(toDomainError(error)).toEqual({ type: 'NOT_FOUND', message: 'gone' });
    expect(toDomainError(new Error('boom'))).toEqual({ type: 'INTERNAL', message: 'boom' });
  });
});

describe('data layer lifetime', () => {
  test('own() creates a resource once and disposes it with the layer', () => {
    const layer = createDataLayer({ userId: 'u1' });
    const dispose = vi.fn();
    const create = vi.fn(() => ({ value: { n: 1 }, dispose }));

    expect(layer.own('x', create)).toBe(layer.own('x', create));
    expect(create).toHaveBeenCalledTimes(1);

    layer.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(layer.disposed).toBe(true);
    expect(() => layer.own('y', create)).toThrow(/disposed/);
  });

  test('nextSeq is monotonic and per layer', () => {
    const a = createDataLayer({ userId: 'u1' });
    const b = createDataLayer({ userId: 'u2' });
    expect([a.nextSeq(), a.nextSeq(), b.nextSeq()]).toEqual([1, 2, 1]);
  });

  test('the request signal aborts with the layer or the per-request signal', () => {
    const layer = createDataLayer({ userId: 'u1' });
    const perRequest = new AbortController();
    const merged = layerRequestSignal(layer, perRequest.signal);
    perRequest.abort();
    expect(merged.aborted).toBe(true);

    const second = layerRequestSignal(layer);
    layer.dispose();
    expect(second.aborted).toBe(true);
  });
});

describe('session swap (spec: logout then login as another user)', () => {
  test('a fetch in flight from session A never lands in session B', async () => {
    setDataLayerSession({ userId: 'user-a' });
    const layerA = getDataLayer();
    const gate = deferred<string[]>();
    let seenSignal: AbortSignal | undefined;
    const pending = layerA.queryClient
      .fetchQuery({
        queryKey: ['threads', 'project', 'p1'],
        queryFn: ({ signal }) => {
          seenSignal = layerRequestSignal(layerA, signal);
          return gate.promise;
        },
      })
      .catch(() => undefined);

    setDataLayerSession({ userId: 'user-b' });
    const layerB = getDataLayer();
    gate.resolve(['thread-of-a']);
    await pending;

    expect(layerB).not.toBe(layerA);
    expect(layerB.userId).toBe('user-b');
    expect(layerA.disposed).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
    expect(layerB.queryClient.getQueryData(['threads', 'project', 'p1'])).toBeUndefined();
  });

  test('switching organization swaps the layer', () => {
    setDataLayerSession({ userId: 'user-a', orgId: null });
    const personal = getDataLayer();
    setDataLayerSession({ userId: 'user-a', orgId: 'org-1' });
    expect(getDataLayer()).not.toBe(personal);
    expect(personal.disposed).toBe(true);
    expect(getDataLayer().orgId).toBe('org-1');
  });

  test('setting the same session keeps the layer', () => {
    setDataLayerSession({ userId: 'user-a' });
    const layer = getDataLayer();
    setDataLayerSession({ userId: 'user-a' });
    expect(getDataLayer()).toBe(layer);
  });
});
