import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { applyActivityUpdated } from '@/data/activities/apply-event';
import { loadActivities } from '@/data/activities/loaders';
import { buildActivity, seedActivities } from '@/data/activities/testing';
import { notifyActivityFailed } from '@/stores/activity-notifications';
import { useActivityPanelStore } from '@/stores/activity-panel-store';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const sonner = (() => ({ error: vi.fn() }))();
mock.module('@/components/ui/toast', () => ({ toast: { error: sonner.error } }));

const api = (() => ({ listActivities: vi.fn() }))();
mock.module('@/lib/api/activities', () => ({ activitiesApi: api }));

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
  useActivityPanelStore.setState({ open: false, tab: 'jobs' });
});
afterEach(() => resetTestDataLayer());

describe('failure toast', () => {
  test('a row that becomes failed raises a toast that opens the panel', () => {
    seedActivities([buildActivity({ id: 'a1', status: 'running' })]);
    const outcome = applyActivityUpdated({
      activity: buildActivity({ id: 'a1', status: 'failed', title: 'Pushing', error: 'rejected' }),
    });
    if (outcome?.becameFailed) notifyActivityFailed(outcome.activity);

    expect(sonner.error).toHaveBeenCalledTimes(1);
    const [, options] = sonner.error.mock.calls[0];
    expect(options.description).toBe('rejected');
    options.action.onClick();
    expect(useActivityPanelStore.getState()).toMatchObject({ open: true, tab: 'activity' });
  });

  test("a member's factory run control that failed raises none: its screen showed the refusal", () => {
    // Retrying #479 from the board showed the same refusal twice: the board's
    // toast and this one.
    seedActivities([buildActivity({ id: 'a2', status: 'running', kind: 'factory.retry' })]);
    const outcome = applyActivityUpdated({
      activity: buildActivity({
        id: 'a2',
        status: 'failed',
        kind: 'factory.retry',
        threadId: null,
        title: 'Retry the factory run for #479',
        error: 'Not retried',
      }),
    });
    if (outcome?.becameFailed) notifyActivityFailed(outcome.activity);
    expect(sonner.error).not.toHaveBeenCalled();
  });

  test('a factory run control an agent asked for still raises the toast', () => {
    seedActivities([buildActivity({ id: 'a3', status: 'running', kind: 'factory.retry' })]);
    const outcome = applyActivityUpdated({
      activity: buildActivity({
        id: 'a3',
        status: 'failed',
        kind: 'factory.retry',
        threadId: 't-agent',
        error: 'Not retried',
      }),
    });
    if (outcome?.becameFailed) notifyActivityFailed(outcome.activity);
    expect(sonner.error).toHaveBeenCalledTimes(1);
  });

  test('the initial list load raises none', async () => {
    const { okAsync } = await import('neverthrow');
    api.listActivities.mockReturnValue(okAsync([buildActivity({ id: 'a1', status: 'failed' })]));
    await loadActivities();
    expect(sonner.error).not.toHaveBeenCalled();
  });
});
