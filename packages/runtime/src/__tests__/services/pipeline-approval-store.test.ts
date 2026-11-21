/**
 * Pipeline approval store unit tests.
 *
 * Validates the in-memory pending-approval registry that bridges
 * `RuntimeActionProvider.requestApproval` (producer) with the REST
 * approval-response endpoint (consumer).
 */

import { describe, test, expect } from 'bun:test';

import { pipelineApprovalStore } from '../../services/pipeline-approval-store.js';

const meta = {
  threadId: 't1',
  userId: 'u1',
  gateId: 'gate-a',
  requestedAt: '2026-01-01T00:00:00Z',
};

describe('pipelineApprovalStore', () => {
  test('register returns a promise that resolves on respond', async () => {
    const id = `t-${Math.random()}`;
    const promise = pipelineApprovalStore.register(id, meta);

    const ack = pipelineApprovalStore.respond(id, 'u1', { decision: 'approve', text: 'lgtm' });
    expect(ack.ok).toBe(true);

    await expect(promise).resolves.toEqual({ decision: 'approve', text: 'lgtm' });
  });

  test('respond returns not_found for unknown approval id', () => {
    const ack = pipelineApprovalStore.respond('nope', 'u1', { decision: 'approve' });
    expect(ack).toEqual({ ok: false, error: 'not_found' });
  });

  test('respond rejects responses from a different user', async () => {
    const id = `t-${Math.random()}`;
    const promise = pipelineApprovalStore.register(id, meta);

    const ack = pipelineApprovalStore.respond(id, 'u2', { decision: 'approve' });
    expect(ack).toEqual({ ok: false, error: 'forbidden' });

    // Original promise still pending — resolve it so the test exits cleanly.
    pipelineApprovalStore.respond(id, 'u1', { decision: 'reject', text: 'cleanup' });
    await expect(promise).resolves.toBeDefined();
  });

  test('register cleans up after respond — second respond is not_found', async () => {
    const id = `t-${Math.random()}`;
    const promise = pipelineApprovalStore.register(id, meta);
    pipelineApprovalStore.respond(id, 'u1', { decision: 'approve' });
    await promise;

    const ack = pipelineApprovalStore.respond(id, 'u1', { decision: 'approve' });
    expect(ack).toEqual({ ok: false, error: 'not_found' });
  });

  test('cancel rejects the pending promise', async () => {
    const id = `t-${Math.random()}`;
    const promise = pipelineApprovalStore.register(id, meta);

    expect(pipelineApprovalStore.cancel(id, 'pipeline-cancelled')).toBe(true);
    await expect(promise).rejects.toThrow('pipeline-cancelled');
  });

  test('cancel returns false for unknown approval id', () => {
    expect(pipelineApprovalStore.cancel('nope')).toBe(false);
  });

  test('timeout rejects the promise after timeoutMs', async () => {
    const id = `t-${Math.random()}`;
    const promise = pipelineApprovalStore.register(id, meta, 30);
    await expect(promise).rejects.toThrow(/timed out after 30ms/);
  });

  test('respond cancels the timer (no rejection after fast respond)', async () => {
    const id = `t-${Math.random()}`;
    const promise = pipelineApprovalStore.register(id, meta, 1000);
    pipelineApprovalStore.respond(id, 'u1', { decision: 'approve' });

    await expect(promise).resolves.toEqual({ decision: 'approve' });
    // If the timer fired despite respond cleaning up, a subsequent respond
    // would land on a still-pending entry. Re-respond to confirm cleanup.
    expect(pipelineApprovalStore.respond(id, 'u1', { decision: 'approve' })).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  test('peek returns metadata for pending approvals only', async () => {
    const id = `t-${Math.random()}`;
    const promise = pipelineApprovalStore.register(id, meta);

    expect(pipelineApprovalStore.peek(id)).toEqual(meta);

    pipelineApprovalStore.respond(id, 'u1', { decision: 'approve' });
    await promise;

    expect(pipelineApprovalStore.peek(id)).toBeUndefined();
  });

  test('list reflects currently-pending approvals', async () => {
    const id1 = `t-${Math.random()}`;
    const id2 = `t-${Math.random()}`;
    const p1 = pipelineApprovalStore.register(id1, meta);
    const p2 = pipelineApprovalStore.register(id2, { ...meta, gateId: 'gate-b' });

    const ids = pipelineApprovalStore.list().map((e) => e.approvalId);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);

    pipelineApprovalStore.respond(id1, 'u1', { decision: 'approve' });
    pipelineApprovalStore.respond(id2, 'u1', { decision: 'reject', text: 'cleanup' });
    await Promise.allSettled([p1, p2]);
  });
});
