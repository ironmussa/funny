/**
 * Approval requests in the data layer (openspec factory-agent-tools): the list
 * is read only when asked, a decline records the server's answer and a refused
 * one changes nothing, and approving a run reads the requests again.
 */
import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import type { FactoryApprovalRequest } from '@funny/shared/contracts/factory';
import { waitFor } from '@funny/test-kit';
import { act, renderHook } from '@testing-library/react';
import { errAsync, okAsync } from 'neverthrow';

import { installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

// Not hoisted under bun test: mock first, then load the modules that read the API.
const api = {
  listApprovalRequests: vi.fn(),
  declineApprovalRequest: vi.fn(),
  approveMerge: vi.fn(),
  listRuns: vi.fn(),
};
mock.module('@/lib/api/factory', () => ({ factoryApi: api }));

const { approveFactoryMerge, declineFactoryApprovalRequest } =
  await import('@/data/factory/actions');
const { useFactoryApprovalRequests } = await import('@/data/factory/hooks');
const { buildFactoryRun } = await import('@/data/factory/testing');

const pending: FactoryApprovalRequest = {
  id: 'q1',
  runId: 'r1',
  projectId: 'p1',
  threadId: 't1',
  kind: 'merge',
  specRevision: null,
  sha: 'a'.repeat(40),
  state: 'pending',
  createdAt: '2026-11-24T23:00:00.000Z',
  resolvedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
  api.listRuns.mockReturnValue(okAsync([]));
});
afterEach(() => resetTestDataLayer());

describe('factory approval requests', () => {
  test('nothing is requested while disabled', async () => {
    api.listApprovalRequests.mockReturnValue(okAsync([pending]));
    const { result } = renderHook(() => useFactoryApprovalRequests('p1', false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toBeUndefined();
    expect(api.listApprovalRequests).not.toHaveBeenCalled();
  });

  test("a decline records the server's answer, and the request stays listed", async () => {
    api.listApprovalRequests.mockReturnValue(okAsync([pending]));
    api.declineApprovalRequest.mockReturnValue(okAsync({ ...pending, state: 'declined' }));
    const { result } = renderHook(() => useFactoryApprovalRequests('p1'));
    await waitFor(() =>
      expect(result.current?.map((request) => request.state)).toEqual(['pending']),
    );

    await act(async () => {
      expect((await declineFactoryApprovalRequest('p1', 'q1')).isOk()).toBe(true);
    });
    expect(api.declineApprovalRequest).toHaveBeenCalledWith('p1', 'q1');
    await waitFor(() =>
      expect(result.current?.map((request) => request.state)).toEqual(['declined']),
    );
  });

  test('a refused decline leaves the request as it was', async () => {
    api.listApprovalRequests.mockReturnValue(okAsync([pending]));
    api.declineApprovalRequest.mockReturnValue(
      errAsync({ type: 'CONFLICT', message: 'no longer pending' }),
    );
    const { result } = renderHook(() => useFactoryApprovalRequests('p1'));
    await waitFor(() => expect(result.current).toHaveLength(1));
    await act(async () => {
      expect((await declineFactoryApprovalRequest('p1', 'q1')).isErr()).toBe(true);
    });
    expect(result.current?.map((request) => request.state)).toEqual(['pending']);
  });

  test('approving a run names the commit and reads the requests again', async () => {
    api.listApprovalRequests
      .mockReturnValueOnce(okAsync([pending]))
      .mockReturnValue(okAsync([{ ...pending, state: 'approved' }]));
    api.approveMerge.mockReturnValue(okAsync(buildFactoryRun({ id: 'r1', state: 'queued' })));
    const { result } = renderHook(() => useFactoryApprovalRequests('p1'));
    await waitFor(() => expect(result.current).toHaveLength(1));

    await act(async () => {
      await approveFactoryMerge('p1', 'r1', pending.sha);
    });
    expect(api.approveMerge).toHaveBeenCalledWith('p1', 'r1', pending.sha);
    await waitFor(() =>
      expect(result.current?.map((request) => request.state)).toEqual(['approved']),
    );
  });
});
