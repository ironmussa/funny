/**
 * Thread fork use case (`fork` and `fork-and-rewind`).
 *
 * Sequence: resolve the actor's runner for the source's project → fork
 * remotely → extract the new thread → register (when applicable) → cache
 * routing → return the runner's body.
 *
 * The only variant-specific step here is where the new thread sits in the
 * runner's response: top-level for `fork`, under `thread` for
 * `fork-and-rewind`. The runner path and the error-message format are
 * transport details owned by the remote adapter.
 *
 * Failure semantics match the legacy route handlers:
 *  - Resolver exceptions propagate unchanged. They are NOT mapped to `fork-failed`.
 *  - Any exception from the remote call onward (transport, malformed JSON,
 *    registry, cache) becomes `fork-failed`. Remote fork and registration are
 *    not atomic, and nothing is retried, so a thread forked on the runner can
 *    be left unregistered if the registry write fails.
 *  - A `null` runner body is returned as-is and nothing is registered.
 */

import { err, ok, type Result } from 'neverthrow';

import { createdThreadId, type RunnerId, type ThreadId } from '../domain/ids.js';
import { DEFAULT_RUNNER_ID } from './create-thread.js';
import { extractForkedThread } from './fork-response.js';
import type {
  ForkThreadCommand,
  ForkThreadPorts,
  RunnerUnavailableReason,
  ThreadRegistration,
} from './ports.js';

export type ForkThreadFailure =
  | { readonly kind: 'no-runner'; readonly reason: RunnerUnavailableReason }
  | { readonly kind: 'remote-error'; readonly status: number; readonly message: string }
  | { readonly kind: 'fork-failed'; readonly cause: unknown };

export interface ForkThreadSuccess {
  /** The runner's full response body, forwarded to the client unchanged. */
  readonly thread: unknown;
  /** Id of the new thread (top-level or nested per variant), if any. */
  readonly threadId?: ThreadId;
  /** The actor's runner the fork ran on. */
  readonly runnerId: RunnerId;
}

export type ForkThread = <U, T>(
  command: ForkThreadCommand<U, T>,
) => Promise<Result<ForkThreadSuccess, ForkThreadFailure>>;

export function makeForkThread(ports: ForkThreadPorts): ForkThread {
  return async ({ actor: namedActor, variant, source: namedSource, body }) => {
    const actor = namedActor.value;
    const source = namedSource.value;
    const resolution = await ports.runners.resolve(actor, source.projectId);
    if (!resolution.ok) return err({ kind: 'no-runner', reason: resolution.reason });
    const { runnerId } = resolution;

    try {
      const response = await ports.remote.fork(
        runnerId,
        actor,
        variant,
        source.id,
        body,
        source.projectId,
      );
      if (!response.ok) {
        return err({ kind: 'remote-error', status: response.status, message: response.message });
      }

      const newThread = extractForkedThread(variant, response.thread);
      const newThreadId: unknown = newThread?.id;
      if (newThreadId && runnerId !== DEFAULT_RUNNER_ID) {
        const id = createdThreadId(String(newThreadId));
        // Registration mirrors the legacy handlers: every field comes from the
        // runner's response, never from the request body.
        const entry: ThreadRegistration = {
          id,
          projectId: source.projectId,
          runnerId,
          userId: actor.userId,
          title: newThread.title,
          model: newThread.model,
          mode: newThread.mode,
          branch: newThread.branch ?? undefined,
          // A fork is never registered as scratch, even when the source is.
          // Preserved legacy behavior; see the open question in
          // openspec/changes/modularize-thread-fork/design.md.
          isScratch: false,
        };
        await ports.registry.register(entry);
        ports.routingCache.remember(id, actor.userId, runnerId);
      }

      return ok({
        thread: response.thread,
        threadId: newThreadId ? createdThreadId(String(newThreadId)) : undefined,
        runnerId,
      });
    } catch (cause) {
      return err({ kind: 'fork-failed', cause });
    }
  };
}
