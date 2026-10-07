/**
 * Public API of the server `threads` module (pilot: thread creation and fork).
 *
 * Entry points:
 *  - `makeCreateThread(ports)`: the transport-independent creation use case.
 *  - `makeForkThread(ports)`: the transport-independent fork use case, for
 *    both the `fork` and `fork-and-rewind` variants.
 *  - `normalizeCreationRequest(payload)`: pure scratch/project normalization.
 *  - `composeCreateThread(env)` / `composeForkThread(env)` in
 *    `./composition.ts`: production wiring. Only bootstrap/route code imports them.
 *
 * Layering (enforced by `scripts/fitness/check-module-boundaries.ts`):
 *  - `domain/`: pure types and rules. No I/O and no framework imports.
 *  - `application/`: the use case and its ports. It depends only on `domain/`.
 *  - `infrastructure/`: adapters over existing server services (runner
 *    resolution, signed forwarding, thread registry, routing cache).
 *  - Code outside the module imports only this file or `composition.ts`.
 *
 * Domain invariants:
 *  - A scratch target has no project and always runs in `local` mode. A project
 *    target needs a project reference.
 *  - The actor comes from authentication only. The runner is always the
 *    actor's own, and there is no cross-user fallback.
 *  - The `__default__` runner bypasses registration and routing cache.
 *  - The HTTP and runtime wire contracts are unchanged. The legacy permissive
 *    payload, including unknown fields, is forwarded as-is.
 *
 * Fork invariants:
 *  - The source thread is the one the owner middleware loaded for the actor;
 *    its runner is resolved through the actor-scoped project lookup only.
 *  - The fork request body is forwarded byte-for-byte, never parsed.
 *  - Registration is derived from the runner's response, never from the
 *    request, with `projectId` taken from the source and `isScratch`
 *    explicitly `false` (preserved legacy behavior).
 *  - The two variants differ only in where the new thread sits in the response
 *    (top-level vs `thread`) and in transport details owned by the adapters
 *    (runner path, error-message format).
 *
 * This is a command-side use case only. Thread list/detail queries stay in
 * `routes/threads.ts` and do not depend on this module. This is not full CQRS.
 */

export {
  normalizeCreationRequest,
  type CreationRejection,
  type CreationRejectionCode,
  type CreationTarget,
  type NormalizedCreation,
} from './domain/creation-target.js';
export {
  authenticatedUserId,
  authorizedThreadId,
  createdThreadId,
  resolvedRunnerId,
  type RunnerId,
  type ThreadId,
  type UserId,
} from './domain/ids.js';
export {
  DEFAULT_RUNNER_ID,
  makeCreateThread,
  type CreateThread,
  type CreateThreadFailure,
  type CreateThreadSuccess,
} from './application/create-thread.js';
export {
  makeForkThread,
  type ForkThread,
  type ForkThreadFailure,
  type ForkThreadSuccess,
} from './application/fork-thread.js';
export type {
  ActorContext,
  CreateThreadCommand,
  CreateThreadPorts,
  CreationIntent,
  ForkSource,
  ForkThreadCommand,
  ForkThreadPorts,
  ForkVariant,
  RemoteCreationResponse,
  RemoteThreadCreationPort,
  RemoteThreadForkPort,
  RunnerResolution,
  RunnerResolutionPort,
  RunnerUnavailableReason,
  SourceRunnerResolutionPort,
  ThreadRegistration,
  ThreadRegistryPort,
  ThreadRoutingCachePort,
} from './application/ports.js';

export { withForkInputs, type OwnershipForkSource } from './domain/fork-input.js';
export { threadOwnedBy, type ThreadOwnedBy } from './domain/proofs/thread-owned-by.js';
