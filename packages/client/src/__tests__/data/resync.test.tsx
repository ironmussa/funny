import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';

import type { Job, ThreadComment } from '@funny/shared';
import { okAsync, ResultAsync } from 'neverthrow';

import { cancelJob } from '@/data/background/actions';
import { loadJobs } from '@/data/background/loaders';
import { getJobsData } from '@/data/background/store';
import { commentsQuery } from '@/data/comments/store';
import { resyncDataLayer } from '@/data/resync';
import { getDataLayer } from '@/data/runtime';

import { buildJob } from '../helpers/builders-lib';
import { deferred, installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const jobsApi = (() => ({ listJobs: vi.fn(), cancelJob: vi.fn() }))();
vi.mock('@/lib/api/jobs', () => ({ jobsApi }));
const threadsApi = (() => ({ getThreadComments: vi.fn() }))();
vi.mock('@/lib/api/threads', () => ({ threadsApi }));

const job = (status: Job['status']) => buildJob({ id: 'j1', threadId: 't1', status });

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('resyncDataLayer', () => {
  test('spec: a forced refresh keeps a pending optimistic change on top', async () => {
    jobsApi.listJobs.mockReturnValue(okAsync([job('running')]));
    await loadJobs();

    const gate = deferred<{ ok: boolean }>();
    jobsApi.cancelJob.mockReturnValue(ResultAsync.fromSafePromise(gate.promise));
    const pending = cancelJob('j1');
    expect(getJobsData().read('j1')?.status).toBe('cancelled');

    // The server still reports the job running while the cancel is in flight.
    await resyncDataLayer();
    expect(jobsApi.listJobs).toHaveBeenCalledTimes(2);
    expect(getJobsData().getSynced('j1')?.status).toBe('running');
    expect(getJobsData().read('j1')?.status).toBe('cancelled');

    gate.resolve({ ok: true });
    await pending;
    expect(getJobsData().read('j1')?.status).toBe('cancelled');
  });

  test('a per-thread cache nobody shows is marked stale, not refetched', async () => {
    threadsApi.getThreadComments.mockReturnValue(okAsync<ThreadComment[]>([]));
    const { queryClient } = getDataLayer();
    await queryClient.fetchQuery(commentsQuery('closed-thread'));
    await resyncDataLayer();
    expect(threadsApi.getThreadComments).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(['comments', 'closed-thread'])?.isInvalidated).toBe(true);
  });
});
