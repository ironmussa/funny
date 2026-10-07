/**
 * Thread creation use case (normal and idle).
 *
 * Sequence: normalize → resolve the actor's runner → create remotely →
 * register (when applicable) → cache routing → return the runner's body.
 *
 * Failure semantics match the legacy route handler:
 *  - Normalization failures return before any I/O.
 *  - Resolver exceptions propagate unchanged. They are NOT mapped to `creation-failed`.
 *  - Any exception from remote creation onward (transport, malformed JSON,
 *    registry, cache) becomes `creation-failed`. Remote creation and
 *    registration are not atomic, and nothing is retried, so a thread created
 *    on the runner can be left unregistered if the registry write fails.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  normalizeCreationRequest,
  targetProjectId,
  type CreationRejection,
} from '../domain/creation-target.js';
import { createdThreadId, type RunnerId, type ThreadId } from '../domain/ids.js';
import type {
  CreateThreadCommand,
  CreateThreadPorts,
  RunnerUnavailableReason,
  ThreadRegistration,
} from './ports.js';

/** Legacy local runner id. Threads on it are not registered or cached. */
export const DEFAULT_RUNNER_ID = '__default__';

export type CreateThreadFailure =
  | ({ readonly kind: 'rejected' } & CreationRejection)
  | {
      readonly kind: 'no-runner';
      readonly scope: 'project' | 'user';
      readonly reason: RunnerUnavailableReason;
    }
  | { readonly kind: 'remote-error'; readonly status: number; readonly message: string }
  | { readonly kind: 'creation-failed'; readonly cause: unknown };

export interface CreateThreadSuccess {
  /** The runner's response body, forwarded to the client unchanged. */
  readonly thread: unknown;
  /** Id the runner returned (top-level or nested), if any. */
  readonly threadId?: ThreadId;
  /** The actor's runner the thread was created on. */
  readonly runnerId: RunnerId;
}

export type CreateThread = (
  command: CreateThreadCommand,
) => Promise<Result<CreateThreadSuccess, CreateThreadFailure>>;

export function makeCreateThread(ports: CreateThreadPorts): CreateThread {
  return async ({ actor, intent, payload: rawPayload }) => {
    const normalized = normalizeCreationRequest(rawPayload);
    if (normalized.isErr()) return err({ kind: 'rejected', ...normalized.error });
    const { target, payload } = normalized.value;

    const resolution = await ports.runners.resolve(actor, target, intent);
    if (!resolution.ok) {
      return err({
        kind: 'no-runner',
        scope: target.kind === 'scratch' ? 'user' : 'project',
        reason: resolution.reason,
      });
    }
    const { runnerId } = resolution;

    try {
      const response = await ports.remote.create(runnerId, actor, intent, payload);
      if (!response.ok) {
        return err({ kind: 'remote-error', status: response.status, message: response.message });
      }

      // The runner's body is untyped JSON. Reading a property off `null` throws
      // here, which (like the legacy handler) surfaces as `creation-failed`.
      const data = response.thread as any;
      const threadId = data.id || data.thread?.id;
      if (threadId && runnerId !== DEFAULT_RUNNER_ID) {
        const id = createdThreadId(threadId);
        const entry: ThreadRegistration = {
          id,
          projectId: targetProjectId(target),
          runnerId,
          userId: actor.userId,
          title: typeof payload.title === 'string' && payload.title ? payload.title : data.title,
          model: typeof payload.model === 'string' ? payload.model : undefined,
          mode: typeof payload.mode === 'string' ? payload.mode : undefined,
          // The runtime generates the worktree branch, so its value wins.
          branch:
            data.branch ??
            (typeof payload.branch === 'string' && payload.branch ? payload.branch : undefined),
          isScratch: target.kind === 'scratch',
        };
        await ports.registry.register(entry);
        ports.routingCache.remember(id, actor.userId, runnerId);
      }

      return ok({
        thread: response.thread,
        threadId: threadId ? createdThreadId(threadId) : undefined,
        runnerId,
      });
    } catch (cause) {
      return err({ kind: 'creation-failed', cause });
    }
  };
}
