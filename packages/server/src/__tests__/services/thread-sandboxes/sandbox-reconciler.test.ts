import { describe, expect, test } from 'bun:test';

import { errAsync, okAsync } from 'neverthrow';

import {
  createSandboxReconciler,
  reconcileAction,
  STALE_IN_FLIGHT_MS,
  type ReconcileCandidate,
} from '../../../services/thread-sandboxes/sandbox-reconciler.js';

const BOOT = Date.parse('2026-11-01T12:00:00Z');
const NOW = BOOT + 60_000;
const before = new Date(BOOT - 60_000).toISOString();
const after = new Date(BOOT + 30_000).toISOString();

const row = (over: Partial<ReconcileCandidate>): ReconcileCandidate => ({
  threadId: 't-1',
  state: 'running',
  sandboxId: 'sb-1',
  runnerId: null,
  updatedAt: after,
  threadExists: true,
  ...over,
});

const clock = { nowMs: NOW, bootedAtMs: BOOT };

describe('reconcileAction', () => {
  test('a setup left by an earlier process is abandoned; a live one is left alone', () => {
    for (const state of ['provisioning', 'installing', 'bootstrapping']) {
      expect(reconcileAction(row({ state, updatedAt: before }), clock)).toBe('abandon');
      expect(reconcileAction(row({ state, updatedAt: after }), clock)).toBeNull();
    }
    // A fresh setup in `connecting` has no runner id yet.
    expect(reconcileAction(row({ state: 'connecting', updatedAt: before }), clock)).toBe('abandon');
  });

  test('an orphaned wake or stop is recovered, keeping the disk', () => {
    expect(
      reconcileAction(row({ state: 'connecting', runnerId: 'r-1', updatedAt: before }), clock),
    ).toBe('recover');
    expect(reconcileAction(row({ state: 'stopping', updatedAt: before }), clock)).toBe('recover');
  });

  test('an operation stalled in this process counts as orphaned after the stale window', () => {
    const stale = new Date(BOOT + 1_000).toISOString();
    const later = { nowMs: BOOT + 1_000 + STALE_IN_FLIGHT_MS, bootedAtMs: BOOT };
    expect(reconcileAction(row({ state: 'installing', updatedAt: stale }), later)).toBe('abandon');
  });

  test('a dead sandbox still holding a machine is released', () => {
    expect(reconcileAction(row({ state: 'failed' }), clock)).toBe('release');
    expect(reconcileAction(row({ state: 'lost' }), clock)).toBe('release');
    expect(reconcileAction(row({ state: 'failed', sandboxId: null }), clock)).toBeNull();
  });

  test('a deleted thread is destroyed once past the grace period', () => {
    expect(reconcileAction(row({ threadExists: false, updatedAt: before }), clock)).toBe('destroy');
    const fresh = new Date(NOW - 1_000).toISOString();
    expect(reconcileAction(row({ threadExists: false, updatedAt: fresh }), clock)).toBeNull();
  });

  test('running and stopped sandboxes are never touched', () => {
    expect(reconcileAction(row({ state: 'running', updatedAt: before }), clock)).toBeNull();
    expect(reconcileAction(row({ state: 'stopped', updatedAt: before }), clock)).toBeNull();
  });
});

describe('sandbox reconciler', () => {
  test('runs each action, counts failures, and leaves them for the next pass', async () => {
    const ran: string[] = [];
    const reconciler = createSandboxReconciler({
      bootedAtMs: BOOT,
      now: () => NOW,
      listCandidates: () =>
        okAsync([
          row({ threadId: 'setup', state: 'installing', updatedAt: before }),
          row({ threadId: 'wake', state: 'connecting', runnerId: 'r-1', updatedAt: before }),
          row({ threadId: 'dead', state: 'failed' }),
          row({ threadId: 'gone', threadExists: false, updatedAt: before }),
          row({ threadId: 'busy', state: 'running' }),
        ]),
      control: {
        abandon: (threadId) => {
          ran.push(`abandon:${threadId}`);
          return okAsync(true);
        },
        recover: (threadId) => {
          ran.push(`recover:${threadId}`);
          return okAsync('stopped');
        },
        release: (threadId) => {
          ran.push(`release:${threadId}`);
          return errAsync({ kind: 'storage', message: 'provider down' });
        },
        destroy: (threadId) => {
          ran.push(`destroy:${threadId}`);
          return okAsync(undefined);
        },
      },
    });
    const report = await reconciler.reconcile();
    expect(ran.sort()).toEqual(['abandon:setup', 'destroy:gone', 'recover:wake', 'release:dead']);
    expect(report).toEqual({ done: { destroy: 1, abandon: 1, recover: 1, release: 0 }, failed: 1 });
  });

  test('a listing failure is a no-op pass', async () => {
    const reconciler = createSandboxReconciler({
      bootedAtMs: BOOT,
      listCandidates: () => errAsync('db down'),
      control: {
        abandon: () => okAsync(true),
        recover: () => okAsync('stopped'),
        release: () => okAsync(true),
        destroy: () => okAsync(undefined),
      },
    });
    expect((await reconciler.reconcile()).failed).toBe(0);
  });
});
