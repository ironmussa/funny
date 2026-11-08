/**
 * Process-wide sandbox lifecycle (change thread-sandboxes): the idle sweeper
 * that stops unused sandboxes, the reconciler that cleans up after crashed or
 * failed operations, and wake-on-demand that resumes a stopped one when its
 * thread is used again. Started once by the server entry point; the periodic
 * pass is an Effect fiber that shutdown interrupts.
 */

import { Effect, Fiber, Schedule } from 'effect';
import { errAsync, ResultAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import { removeRunner } from '../runner-manager.js';
import { sandboxRunnerIdForThread } from '../runner-scope.js';
import { createSandboxIdleSweeper, DEFAULT_SANDBOX_IDLE_MS } from './idle-sweeper.js';
import { createInfraConnectionService } from './infra-connections.js';
import { productionSandboxProviders } from './provider-catalog.js';
import { cancelAllProvisions, cancelProvision } from './provision-registry.js';
import { postSandboxError, sandboxErrorEventData } from './sandbox-events.js';
import { createSandboxReconciler } from './sandbox-reconciler.js';
import { createThreadSandboxControl, type ThreadSandboxControl } from './thread-sandbox-control.js';
import type { ProvisionError } from './thread-sandbox-service.js';
import { sqlThreadSandboxStore, type ThreadSandboxStore } from './thread-sandbox-store.js';

const SWEEP_INTERVAL_MS = 60_000;
/** Bound on how long a request waits for its sandbox to wake up. */
const WAKE_TIMEOUT_MS = 90_000;

export interface SandboxWaker {
  /**
   * Resume the thread's stopped sandbox on behalf of its owner. Concurrent
   * calls for one thread share the same resume.
   */
  wake(threadId: string, ownerId: string): ResultAsync<string, ProvisionError>;
}

export function createSandboxWaker(deps: {
  control: Pick<ThreadSandboxControl, 'resume'>;
  store: Pick<ThreadSandboxStore, 'get'>;
  timeoutMs?: number;
  /** Called once per failed resume (not per waiting request) to tell the user. */
  onWakeFailed?: (threadId: string, ownerId: string, error: ProvisionError) => void;
}): SandboxWaker {
  const inFlight = new Map<string, ResultAsync<string, ProvisionError>>();

  const resume = (threadId: string, ownerId: string) =>
    deps.store
      .get(threadId)
      .mapErr((message): ProvisionError => ({ kind: 'storage', message }))
      .andThen((row) => {
        // Only the owner's own sandbox, and only a stopped one (never lost/failed).
        if (!row || row.userId !== ownerId || row.state !== 'stopped') {
          return errAsync<string, ProvisionError>({
            kind: 'sandbox',
            message: 'no stopped sandbox to wake',
            cause: 'not-found',
          });
        }
        return deps.control
          .resume(threadId, AbortSignal.timeout(deps.timeoutMs ?? WAKE_TIMEOUT_MS))
          .mapErr((error) => {
            deps.onWakeFailed?.(threadId, ownerId, error);
            return error;
          });
      })
      .map((runnerId) => {
        metric('thread_sandboxes.woken', 1);
        return runnerId;
      });

  return {
    wake(threadId, ownerId) {
      const pending = inFlight.get(threadId);
      if (pending) return pending;
      const shared = new ResultAsync(
        (async () => {
          try {
            return await resume(threadId, ownerId);
          } finally {
            inFlight.delete(threadId);
          }
        })(),
      );
      inFlight.set(threadId, shared);
      return shared;
    },
  };
}

let waker: SandboxWaker | null = null;
let control: ThreadSandboxControl | null = null;
let lifecycleFiber: Fiber.Fiber<unknown, unknown> | null = null;

/**
 * Destroy a deleted thread's sandbox, if it has one. Never throws; failures
 * are logged and leave the sandbox row in state `failed`.
 */
export async function destroyThreadSandbox(threadId: string): Promise<void> {
  // A preparation still running stops at its next step and destroys the machine
  // it created; the destroy below covers a machine that already exists.
  cancelProvision(threadId);
  if (!control) return;
  const result = await control.destroy(threadId);
  if (result.isErr()) {
    log.error('Failed to destroy the sandbox of a deleted thread', {
      namespace: 'thread-sandboxes',
      threadId,
      kind: result.error.kind,
      error: result.error.message,
    });
  }
}

/** The running waker, or null when the lifecycle was not started. */
export function sandboxWaker(): SandboxWaker | null {
  return waker;
}

function idleWindowMs(): number {
  const raw = Number(process.env.FUNNY_SANDBOX_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SANDBOX_IDLE_MS;
}

export function startSandboxLifecycle(deps: {
  presence: { isAvailable(runnerId: string): boolean } | undefined;
  browserEvents?: { toUser(userId: string, event: Record<string, unknown>): void };
}): void {
  if (lifecycleFiber) return;
  const registry = productionSandboxProviders();
  if (registry.isErr()) {
    log.error('Sandbox lifecycle disabled: provider registry invalid', {
      namespace: 'thread-sandboxes',
      error: registry.error.kind,
    });
    return;
  }
  control = createThreadSandboxControl({
    connections: createInfraConnectionService(registry.value),
    sandboxRunnerIdForThread,
    presence: deps.presence,
    store: sqlThreadSandboxStore,
    removeRunner,
  });
  waker = createSandboxWaker({
    control,
    store: sqlThreadSandboxStore,
    onWakeFailed: (threadId, ownerId, error) =>
      void postSandboxError(
        { threadId, userId: ownerId, data: sandboxErrorEventData('wake', error) },
        deps.browserEvents,
      ),
  });
  const sweeper = createSandboxIdleSweeper({ control, idleMs: idleWindowMs() });
  const reconciler = createSandboxReconciler({ control, bootedAtMs: Date.now() });

  // Reconcile first (sandboxes a previous process left mid-operation), then
  // every interval; passes never overlap. A failing pass is logged and the
  // loop goes on.
  const pass = Effect.promise(async () => {
    const report = await reconciler.reconcile();
    const acted = Object.values(report.done).some((n) => n > 0) || report.failed > 0;
    if (acted) log.info('Sandbox reconcile pass', { namespace: 'thread-sandboxes', ...report });
    await sweeper.sweep();
  });
  lifecycleFiber = Effect.runFork(
    Effect.repeat(
      Effect.catchCause(pass, (cause) =>
        Effect.sync(() =>
          log.error('Sandbox lifecycle pass failed', {
            namespace: 'thread-sandboxes',
            error: String(cause),
          }),
        ),
      ),
      Schedule.spaced(SWEEP_INTERVAL_MS),
    ),
  );
}

/** Bound on how long shutdown waits for cancelled setups to destroy their machines. */
const SHUTDOWN_GRACE_MS = 3_000;

/**
 * Stop the periodic pass and cancel every sandbox setup in flight, so each
 * destroys the machine it created before the process exits. What does not
 * finish within the grace period is cleaned up by the next start's reconcile.
 */
export async function stopSandboxLifecycle(): Promise<void> {
  const fiber = lifecycleFiber;
  lifecycleFiber = null;
  waker = null;
  control = null;
  const cancelled = await cancelAllProvisions(SHUTDOWN_GRACE_MS);
  if (cancelled > 0) {
    log.info('Cancelled sandbox setups on shutdown', {
      namespace: 'thread-sandboxes',
      cancelled,
    });
  }
  if (fiber) await Effect.runPromise(Fiber.interrupt(fiber));
}
