import type { Job, Watcher } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { act, renderHook, waitFor } from '@testing-library/react';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { cancelJob, cancelWatcher } from '@/data/background/actions';
import { useJobsById, useThreadJobsById } from '@/data/background/hooks';
import { applyJobEvent, loadJobs, loadWatchers } from '@/data/background/loaders';
import { getJobsData, getWatchersData } from '@/data/background/store';
import { seedBackgroundActivity } from '@/data/background/testing';

import { deferred, installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const api = vi.hoisted(() => ({
  listJobs: vi.fn(),
  cancelJob: vi.fn(),
  listWatchers: vi.fn(),
  cancelWatcher: vi.fn(),
}));
vi.mock('@/lib/api/jobs', () => ({
  jobsApi: { listJobs: api.listJobs, cancelJob: api.cancelJob },
}));
vi.mock('@/lib/api/watchers', () => ({
  watchersApi: { listWatchers: api.listWatchers, cancelWatcher: api.cancelWatcher },
}));

const effects = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock('@/platform/client-composition', () => ({
  clientComposition: { platform: { effects } },
}));

const job = (id: string, overrides: Partial<Job> = {}) =>
  ({ id, threadId: 't1', status: 'running', ...overrides }) as Job;
const watcher = (id: string, overrides: Partial<Watcher> = {}) =>
  ({ id, threadId: 't1', status: 'pending', ...overrides }) as Watcher;
const failure: DomainError = { type: 'INTERNAL', message: 'boom' };

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('loading', () => {
  test('spec: two components mounting together make a single request', async () => {
    const gate = deferred<Job[]>();
    api.listJobs.mockReturnValue(ResultAsync.fromSafePromise(gate.promise));
    const first = loadJobs();
    const second = loadJobs();
    gate.resolve([job('j1')]);
    await Promise.all([first, second]);
    expect(api.listJobs).toHaveBeenCalledTimes(1);
    expect(getJobsData().getSynced('j1')).toBeDefined();
  });

  test('a load replaces the list; without a session nothing is requested', async () => {
    seedBackgroundActivity({ watchers: [watcher('gone')] });
    api.listWatchers.mockReturnValue(okAsync([watcher('w1')]));
    await loadWatchers();
    expect([...getWatchersData().collection.keys()]).toEqual(['w1']);

    installTestDataLayer(null);
    const skipped = await loadWatchers();
    expect(skipped.isOk() && skipped.value).toBeNull();
    expect(api.listWatchers).toHaveBeenCalledTimes(1);
  });

  test('realtime events reach per-thread readers', async () => {
    const { result } = renderHook(() => useThreadJobsById('t1'));
    act(() => {
      applyJobEvent(job('j1'));
      applyJobEvent(job('other', { threadId: 't2' }));
    });
    await waitFor(() => expect(Object.keys(result.current)).toEqual(['j1']));
  });
});

describe('cancelling', () => {
  beforeEach(() => seedBackgroundActivity({ jobs: [job('j1')], watchers: [watcher('w1')] }));

  test('a job cancel shows at once and stays cancelled until the runner event', async () => {
    const { result } = renderHook(() => useJobsById());
    api.cancelJob.mockReturnValue(okAsync({ ok: true }));
    const pending = cancelJob('j1');
    await waitFor(() => expect(result.current.j1?.status).toBe('cancelled'));
    await act(async () => {
      await pending;
    });
    expect(result.current.j1?.status).toBe('cancelled');
  });

  test('a refused watcher cancel rolls back with a toast', async () => {
    api.cancelWatcher.mockReturnValue(errAsync(failure));
    expect((await cancelWatcher('w1')).isErr()).toBe(true);
    expect(getWatchersData().read('w1')?.status).toBe('pending');
    expect(effects.emit).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });
});
