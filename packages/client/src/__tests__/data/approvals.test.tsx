import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';

import type {
  WSPipelineApprovalRequestedData,
  WSPipelineApprovalResolvedData,
} from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { act, renderHook, waitFor } from '@testing-library/react';
import { errAsync, okAsync, ResultAsync } from 'neverthrow';

import { usePendingApprovals } from '@/data/approvals/hooks';
import {
  applyApprovalRequested,
  applyApprovalResolved,
  getApprovalsData,
  respondToApproval,
} from '@/data/approvals/store';

import { deferred, installTestDataLayer, resetTestDataLayer } from '../helpers/data-layer-harness';

const api = (() => ({ respondToApproval: vi.fn() }))();
mock.module('@/lib/api/pipelines', () => ({ pipelinesApi: api }));
const effects = (() => ({ emit: vi.fn() }))();
mock.module('@/platform/client-composition', () => ({
  clientComposition: { platform: { effects } },
}));

const request = (approvalId: string, requestedAt: string): WSPipelineApprovalRequestedData => ({
  approvalId,
  gateId: 'g1',
  threadId: 't1',
  requestedAt,
  message: 'Ship it?',
  captureResponse: false,
});
const resolved = (approvalId: string): WSPipelineApprovalResolvedData => ({
  approvalId,
  gateId: 'g1',
  threadId: 't1',
  decision: 'approve',
});
const refused: DomainError = { type: 'INTERNAL', message: 'gate already closed' };

beforeEach(() => {
  vi.clearAllMocks();
  installTestDataLayer();
});
afterEach(() => resetTestDataLayer());

describe('pipeline approvals', () => {
  test('requests queue oldest first; a resolve removes one; unknown resolves are no-ops', async () => {
    applyApprovalRequested(request('b', '2026-01-02'));
    applyApprovalRequested(request('a', '2026-01-01'));
    applyApprovalResolved(resolved('missing'));
    const { result } = renderHook(() => usePendingApprovals());
    await waitFor(() => expect(result.current.map((a) => a.approvalId)).toEqual(['a', 'b']));
    act(() => applyApprovalResolved(resolved('a')));
    await waitFor(() => expect(result.current.map((a) => a.approvalId)).toEqual(['b']));
  });

  test('spec: approving hides the approval at once and keeps it hidden when confirmed', async () => {
    applyApprovalRequested(request('a', '2026-01-01'));
    const gate = deferred<{ ok: boolean }>();
    api.respondToApproval.mockReturnValue(ResultAsync.fromSafePromise(gate.promise));
    const pending = respondToApproval('a', 'approve');
    expect(getApprovalsData().read('a')).toBeUndefined();
    gate.resolve({ ok: true });
    expect((await pending).isOk()).toBe(true);
    expect(getApprovalsData().read('a')).toBeUndefined();
    expect(api.respondToApproval).toHaveBeenCalledWith('a', {
      decision: 'approve',
      text: undefined,
    });
  });

  test('spec: a refused rejection brings the approval back with the server error', async () => {
    applyApprovalRequested(request('a', '2026-01-01'));
    api.respondToApproval.mockReturnValue(errAsync(refused));
    expect((await respondToApproval('a', 'reject', 'not yet')).isErr()).toBe(true);
    expect(getApprovalsData().read('a')?.submitError).toBe('gate already closed');
    expect(effects.emit).toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
  });

  test('answering an unknown approval is refused without a request', async () => {
    api.respondToApproval.mockReturnValue(okAsync({ ok: true }));
    expect((await respondToApproval('nope', 'approve')).isErr()).toBe(true);
    expect(api.respondToApproval).not.toHaveBeenCalled();
  });
});
