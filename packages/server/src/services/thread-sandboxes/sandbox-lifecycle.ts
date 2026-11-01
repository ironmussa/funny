/**
 * Process-wide sandbox lifecycle (change thread-sandboxes): the idle sweeper
 * that stops unused sandboxes, and wake-on-demand that resumes a stopped one
 * when its thread is used again. Started once by the server entry point.
 */

import { errAsync, ResultAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import { removeRunner } from '../runner-manager.js';
import { sandboxRunnerIdForThread } from '../runner-scope.js';
import { createSandboxIdleSweeper, DEFAULT_SANDBOX_IDLE_MS } from './idle-sweeper.js';
import { createInfraConnectionService } from './infra-connections.js';
import { productionSandboxProviders } from './provider-catalog.js';
import { cancelProvision } from './provision-registry.js';
import { postSandboxError, sandboxErrorEventData } from './sandbox-events.js';
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
let sweepTimer: ReturnType<typeof setInterval> | null = null;

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
  if (sweepTimer) return;
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
  let sweeping = false;
  sweepTimer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweeper.sweep().finally(() => {
      sweeping = false;
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopSandboxLifecycle(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  waker = null;
  control = null;
}
