import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { err } from 'neverthrow';

const mocks = (() => ({ analyticsOverview: vi.fn(), analyticsTimeline: vi.fn() }))();
mock.module('@/lib/api', () => ({
  api: { analyticsOverview: mocks.analyticsOverview, analyticsTimeline: mocks.analyticsTimeline },
}));
mock.module('@/data/projects/hooks', () => ({ useProjects: () => [] }));
mock.module('@/stores/project-store', () => ({
  useProjectStore: (selector: (state: { selectedProjectId: string | null }) => unknown) =>
    selector({ selectedProjectId: null }),
}));

const { AnalyticsView } = await import('@/components/AnalyticsView');

/** A request the test settles by hand, with the API's "no data" result. */
function deferredEmpty() {
  let settle = () => {};
  const promise = new Promise((resolve) => {
    settle = () => resolve(err({ message: 'none' }));
  });
  return { promise, settle };
}

beforeEach(() => {
  mocks.analyticsOverview.mockReset();
  mocks.analyticsTimeline.mockReset();
});
afterEach(cleanup);

describe('AnalyticsView loading', () => {
  test('loads on mount, and a filter change shows loading until its own request settles', async () => {
    const first = deferredEmpty();
    const second = deferredEmpty();
    mocks.analyticsOverview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mocks.analyticsTimeline.mockReturnValue(Promise.resolve(err({ message: 'none' })));

    render(<AnalyticsView />);
    expect(screen.getByTestId('analytics-loading')).toBeTruthy();

    // Switch the range while the first request is still pending.
    fireEvent.click(screen.getByTestId('analytics-time-range-week'));
    expect(mocks.analyticsOverview).toHaveBeenLastCalledWith(undefined, 'week');

    // The superseded request settling does not end the newer one's loading.
    await act(async () => first.settle());
    expect(screen.getByTestId('analytics-loading')).toBeTruthy();

    await act(async () => second.settle());
    expect(screen.queryByTestId('analytics-loading')).toBeNull();
    expect(screen.getByTestId('analytics-no-data')).toBeTruthy();
  });
});
