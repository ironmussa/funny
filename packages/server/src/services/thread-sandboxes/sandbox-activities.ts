/**
 * @domain subdomain: Thread Sandboxes
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: ThreadSandboxControl, ThreadSandboxStore, ServerActivities
 *
 * Records what funny does to a sandbox on its own (track-funny-actions,
 * design D7): a decorator over `ThreadSandboxControl` for one caller (the
 * idle sweeper, the reconciler, the waker, thread deletion), which knows why
 * it acts. Stopping and waking are recorded only when they fail; destroying
 * a machine is recorded every time. The activity belongs to the sandbox
 * row's owner, read before the operation (a destroy drops the row).
 */
import type { ActivityOrigin } from '@funny/shared';
import { ResultAsync } from 'neverthrow';

import { createServerActivities, type ServerActivities } from '../activities/server-activities.js';
import type { ThreadSandboxControl } from './thread-sandbox-control.js';
import type { ThreadSandboxStore } from './thread-sandbox-store.js';

export type SandboxDestroyReason = 'idle' | 'thread-deleted' | 'reconciled' | 'released';

export interface SandboxActivityContext {
  /** Why this caller destroys a machine. */
  destroyReason: SandboxDestroyReason;
  origin: ActivityOrigin;
  store: Pick<ThreadSandboxStore, 'get'>;
  activities?: Pick<ServerActivities, 'recordServerActivity'>;
}

type Control = Pick<
  ThreadSandboxControl,
  'stop' | 'resume' | 'destroy' | 'release' | 'recover' | 'abandon'
>;

let shared: ServerActivities | null = null;

export function recordingSandboxControl<C extends Partial<Control>>(
  control: C,
  context: SandboxActivityContext,
): C {
  const activities = context.activities ?? (shared ??= createServerActivities());

  const ownerOf = async (threadId: string): Promise<string | null> => {
    const row = await context.store.get(threadId);
    return row.isOk() ? (row.value?.userId ?? null) : null;
  };

  /**
   * Reads the row's owner, runs `op`, then records it for that owner (nothing
   * without a row). Recording never fails: a write failure is logged.
   */
  function recorded<T, E extends { message: string }>(
    threadId: string,
    op: () => ResultAsync<T, E>,
    record: (
      ownerId: string,
      outcome: { ok: true; value: T } | { ok: false; error: E },
    ) => Promise<void>,
  ): ResultAsync<T, E> {
    return new ResultAsync(
      (async () => {
        const ownerId = await ownerOf(threadId);
        const result = await op();
        if (ownerId) {
          await record(
            ownerId,
            result.isOk() ? { ok: true, value: result.value } : { ok: false, error: result.error },
          );
        }
        return result;
      })(),
    );
  }

  const destroyed = (
    threadId: string,
    ownerId: string,
    outcome: { ok: boolean; error?: string },
    reason: SandboxDestroyReason = context.destroyReason,
  ) =>
    activities.recordServerActivity(
      {
        kind: 'sandbox.destroy',
        userId: ownerId,
        threadId,
        title: 'Destroyed the sandbox',
        input: { reason },
        origin: context.origin,
      },
      outcome.ok
        ? { ok: true, effects: [{ effect: 'sandbox-destroyed', target: threadId }] }
        : { ok: false, error: outcome.error ?? 'Failed' },
    );

  const decorated: Partial<Control> = {};
  if (control.stop) {
    const stop = control.stop;
    decorated.stop = (threadId) =>
      recorded(
        threadId,
        () => stop(threadId),
        async (ownerId, outcome) => {
          // An ephemeral provider destroys the machine instead of stopping it.
          if (outcome.ok && outcome.value !== 'stopped') {
            await destroyed(threadId, ownerId, { ok: true });
            return;
          }
          await activities.recordServerActivity(
            {
              kind: 'sandbox.stop',
              userId: ownerId,
              threadId,
              title: 'Stop the sandbox',
              input: { reason: context.destroyReason === 'idle' ? 'idle' : 'requested' },
              origin: context.origin,
            },
            outcome.ok ? { ok: true } : { ok: false, error: outcome.error.message },
          );
        },
      );
  }
  if (control.resume) {
    const resume = control.resume;
    decorated.resume = (threadId, signal) =>
      recorded(
        threadId,
        () => resume(threadId, signal),
        (ownerId, outcome) =>
          activities.recordServerActivity(
            {
              kind: 'sandbox.wake',
              userId: ownerId,
              threadId,
              title: 'Wake the sandbox',
              input: {},
              origin: context.origin,
            },
            outcome.ok ? { ok: true } : { ok: false, error: outcome.error.message },
          ),
      );
  }
  if (control.destroy) {
    const destroy = control.destroy;
    decorated.destroy = (threadId) =>
      recorded(
        threadId,
        () => destroy(threadId),
        (ownerId, outcome) =>
          destroyed(
            threadId,
            ownerId,
            outcome.ok ? { ok: true } : { ok: false, error: outcome.error.message },
          ),
      );
  }
  if (control.release) {
    const release = control.release;
    decorated.release = (threadId) =>
      recorded(
        threadId,
        () => release(threadId),
        async (ownerId, outcome) => {
          // Nothing to free: nothing was destroyed.
          if (outcome.ok && !outcome.value) return;
          await destroyed(
            threadId,
            ownerId,
            outcome.ok ? { ok: true } : { ok: false, error: outcome.error.message },
            'released',
          );
        },
      );
  }
  if (control.abandon) {
    const abandon = control.abandon;
    decorated.abandon = (threadId, reason) =>
      recorded(
        threadId,
        () => abandon(threadId, reason),
        async (ownerId, outcome) => {
          if (outcome.ok && !outcome.value) return;
          await destroyed(
            threadId,
            ownerId,
            outcome.ok ? { ok: true } : { ok: false, error: outcome.error.message },
          );
        },
      );
  }
  return { ...control, ...decorated } as C;
}
