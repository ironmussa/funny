/**
 * Public API of the server `threads` module (pilot: thread creation).
 *
 * Entry points:
 *  - `makeCreateThread(ports)`: the transport-independent creation use case.
 *  - `normalizeCreationRequest(payload)`: pure scratch/project normalization.
 *  - `composeCreateThread(env)` in `./composition.ts`: production wiring. Only
 *    bootstrap/route code imports it.
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
export type {
  ActorContext,
  CreateThreadCommand,
  CreateThreadPorts,
  CreationIntent,
  RemoteCreationResponse,
  RemoteThreadCreationPort,
  RunnerResolutionPort,
  ThreadRegistration,
  ThreadRegistryPort,
  ThreadRoutingCachePort,
} from './application/ports.js';
