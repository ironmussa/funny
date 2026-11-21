import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';

import type { DomainError } from '@funny/shared/errors';
import { act, renderHook, waitFor } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';

import { clearFinishedActivities, dismissActivity } from '@/data/activities/actions';
import {
  applyActivitiesRemoved,
  applyActivityProgress,
  applyActivityUpdated,
} from '@/data/activities/apply-event';
import { useActivities, useActivityCounts, useActivityProgress } from '@/data/activities/hooks';
import { loadActivities } from '@/data/activities/loaders';
import { getActivitiesData } from '@/data/activities/store';
import { buildActivity, seedActivities } from '@/data/activities/testing';
import { resyncDataLayer } from '@/data/resync';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const api = (() => ({
  listActivities: vi.fn(),
  dismissActivity: vi.fn(),
  clearFinishedActivities: vi.fn(),
}))();
vi.mock('@/lib/api/activities', () => ({ activitiesApi: api }));

const effects = (() => ({ emit: vi.fn() }))();
vi.mock('@/platform/client-composition', () => ({
  clientComposition: { platform: { effects } },
}));

const failure: DomainError = { type: 'CONFLICT', message: 'still running' };

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('reads', () => {
  test('lists running first, then finished newest first', async () => {
    seedActivities([
      buildActivity({ id: 'old', status: 'succeeded', endedAt: '2026-11-20T10:01:00.000Z' }),
      buildActivity({ id: 'run', status: 'running', startedAt: '2026-11-20T09:00:00.000Z' }),
      buildActivity({ id: 'new', status: 'failed', endedAt: '2026-11-20T10:05:00.000Z' }),
    ]);
    const { result } = renderHook(() => useActivities());
    await waitFor(() => expect(result.current.map((a) => a.id)).toEqual(['run', 'new', 'old']));
  });

  test('counts running and failed or interrupted activities', async () => {
    seedActivities([
      buildActivity({ id: 'a', status: 'running' }),
      buildActivity({ id: 'b', status: 'running' }),
      buildActivity({ id: 'c', status: 'failed' }),
      buildActivity({ id: 'd', status: 'succeeded' }),
    ]);
    const { result } = renderHook(() => useActivityCounts());
    await waitFor(() => expect(result.current).toEqual({ running: 2, failed: 1 }));
  });

  test('a load replaces the list', async () => {
    seedActivities([buildActivity({ id: 'gone' })]);
    api.listActivities.mockReturnValue(okAsync([buildActivity({ id: 'a1' })]));
    await loadActivities();
    expect([...getActivitiesData().collection.keys()]).toEqual(['a1']);
  });
});

describe('realtime', () => {
  test('an update replaces the row and reports a new failure once', () => {
    seedActivities([buildActivity({ id: 'a1', status: 'running' })]);
    const first = applyActivityUpdated({
      activity: buildActivity({ id: 'a1', status: 'failed', error: 'exists' }),
    });
    expect(first?.becameFailed).toBe(true);
    expect(getActivitiesData().getSynced('a1')?.error).toBe('exists');
    const again = applyActivityUpdated({ activity: buildActivity({ id: 'a1', status: 'failed' }) });
    expect(again?.becameFailed).toBe(false);
  });

  test('a removal deletes the rows', () => {
    seedActivities([buildActivity({ id: 'a1' }), buildActivity({ id: 'a2' })]);
    applyActivitiesRemoved({ ids: ['a1'] });
    expect([...getActivitiesData().collection.keys()]).toEqual(['a2']);
  });

  test('progress is kept for a running row and ignored for an unknown id', async () => {
    seedActivities([buildActivity({ id: 'a1', status: 'running' })]);
    const { result } = renderHook(() => useActivityProgress());
    act(() => {
      applyActivityProgress({ id: 'a1', percent: 42 });
      applyActivityProgress({ id: 'unknown', percent: 10 });
    });
    await waitFor(() => expect(result.current).toEqual({ a1: 42 }));
  });
});

describe('writes', () => {
  test('a dismiss hides the row at once', async () => {
    seedActivities([buildActivity({ id: 'a1', status: 'failed' })]);
    api.dismissActivity.mockReturnValue(okAsync({ ids: ['a1'] }));
    await dismissActivity('a1');
    expect(getActivitiesData().read('a1')).toBeUndefined();
  });

  test('a rejected dismiss restores the row with a toast', async () => {
    seedActivities([buildActivity({ id: 'a1', status: 'running' })]);
    api.dismissActivity.mockReturnValue(errAsync(failure));
    expect((await dismissActivity('a1')).isErr()).toBe(true);
    expect(getActivitiesData().read('a1')?.status).toBe('running');
    expect(effects.emit).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });

  test('clear finished keeps running rows', async () => {
    seedActivities([
      buildActivity({ id: 'run', status: 'running' }),
      buildActivity({ id: 'done', status: 'succeeded' }),
    ]);
    api.clearFinishedActivities.mockReturnValue(okAsync({ ids: ['done'] }));
    await clearFinishedActivities();
    expect([...getActivitiesData().collection.keys()]).toEqual(['run']);
  });
});

describe('resync', () => {
  test('a row that changed while disconnected is updated', async () => {
    api.listActivities.mockReturnValue(okAsync([buildActivity({ id: 'a1', status: 'running' })]));
    await loadActivities();
    api.listActivities.mockReturnValue(okAsync([buildActivity({ id: 'a1', status: 'failed' })]));
    await resyncDataLayer();
    expect(getActivitiesData().getSynced('a1')?.status).toBe('failed');
  });
});
