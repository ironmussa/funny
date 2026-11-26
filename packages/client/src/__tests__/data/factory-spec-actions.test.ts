/**
 * Approving a run's spec in the data layer (openspec factory-spec-stage): the
 * revision on screen is sent, and a refusal reads the runs again so the
 * member sees the newer draft.
 */
import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import { waitFor } from '@funny/test-kit';
import { act, renderHook } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

// Not hoisted under bun test: mock first, then load the modules that read the API.
const api = {
  approveSpec: vi.fn(),
  reopenSpec: vi.fn(),
  listRuns: vi.fn(),
  listApprovalRequests: vi.fn(),
};
mock.module('@/lib/api/factory', () => ({ factoryApi: api }));

const { approveFactorySpec, reopenFactorySpec } = await import('@/data/factory/actions');
const { useFactoryRuns } = await import('@/data/factory/hooks');
const { buildFactoryRun } = await import('@/data/factory/testing');

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
  api.listApprovalRequests.mockReturnValue(okAsync([]));
});
afterEach(() => resetTestDataLayer());

describe('approving a spec', () => {
  test('sends the revision on screen and records the run the server answers', async () => {
    const waiting = buildFactoryRun({ id: 'r1', state: 'needs_spec' });
    api.listRuns.mockReturnValue(okAsync([waiting]));
    api.approveSpec.mockReturnValue(okAsync({ ...waiting, state: 'requested' }));
    const { result } = renderHook(() => useFactoryRuns('p1'));
    await waitFor(() => expect(result.current?.[0]?.state).toBe('needs_spec'));

    await act(async () => {
      expect((await approveFactorySpec('p1', 'r1', 3)).isOk()).toBe(true);
    });
    expect(api.approveSpec).toHaveBeenCalledWith('p1', 'r1', 3);
    await waitFor(() => expect(result.current?.[0]?.state).toBe('requested'));
  });

  test('a refused approval (409) reads the runs again: the newer draft shows', async () => {
    const waiting = buildFactoryRun({ id: 'r1', state: 'needs_spec' });
    api.listRuns
      .mockReturnValueOnce(okAsync([waiting]))
      .mockReturnValue(
        okAsync([{ ...waiting, spec: { revision: 4, latest: undefined, threadId: 't-spec' } }]),
      );
    api.approveSpec.mockReturnValue(
      errAsync({ type: 'CONFLICT', message: 'The spec writer stored a newer draft.' }),
    );
    const { result } = renderHook(() => useFactoryRuns('p1'));
    await waitFor(() => expect(result.current).toHaveLength(1));

    await act(async () => {
      expect((await approveFactorySpec('p1', 'r1', 3)).isErr()).toBe(true);
    });
    await waitFor(() => expect(result.current?.[0]?.spec?.revision).toBe(4));
    expect(api.listRuns).toHaveBeenCalledTimes(2);
  });

  test('reopening records the run waiting on its spec again', async () => {
    api.listRuns.mockReturnValue(okAsync([]));
    api.reopenSpec.mockReturnValue(okAsync(buildFactoryRun({ id: 'r1', state: 'needs_spec' })));
    expect((await reopenFactorySpec('p1', 'r1')).isOk()).toBe(true);
    expect(api.reopenSpec).toHaveBeenCalledWith('p1', 'r1');
  });
});
