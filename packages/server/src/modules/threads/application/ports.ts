/**
 * Ports for thread creation and forking: the effects the use cases need, and
 * nothing more.
 *
 * Ownership:
 *  - RunnerResolutionPort: the requesting user's runner selection for a new
 *    thread (runner-manager / runner-resolver). It must never return another
 *    user's runner.
 *  - SourceRunnerResolutionPort: the same selection for a fork, keyed by the
 *    source thread's project. Actor-scoped, no cross-user fallback.
 *  - RemoteThreadCreationPort / RemoteThreadForkPort: the signed identity
 *    forwarding plus the runner request transport (`RunnerRequestPort`).
 *    Headers, secrets, paths, JSON, and the per-variant error format live here.
 *  - ThreadRegistryPort: the central DB thread registry (`thread-registry`).
 *  - ThreadRoutingCachePort: the in-memory thread→runner routing cache (`runner-resolver`).
 *
 * Adapters may throw. The use cases map those throws to the same results the
 * legacy handlers produced (see create-thread.ts and fork-thread.ts).
 */

import type { Named } from '@gdp-ts/core';

import type { CreationTarget } from '../domain/creation-target.js';
import type { ActorContext, OwnershipForkSource } from '../domain/fork-input.js';
import type { RunnerId, ThreadId, UserId } from '../domain/ids.js';
import type { ThreadOwnedBy } from '../domain/proofs/thread-owned-by.js';

/** `normal` → POST /api/threads on the runner. `idle` → POST /api/threads/idle. */
export type CreationIntent = 'normal' | 'idle';

export type { ActorContext } from '../domain/fork-input.js';

export interface CreateThreadCommand {
  readonly actor: ActorContext;
  readonly intent: CreationIntent;
  /** Legacy permissive creation envelope (already parsed as a JSON object). */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Why no runner of the actor could serve the target (mirrors the resolver's reasons). */
export type RunnerUnavailableReason = 'project-runner-offline' | 'general-runner-offline';

export type RunnerResolution =
  | { readonly ok: true; readonly runnerId: RunnerId }
  | { readonly ok: false; readonly reason: RunnerUnavailableReason };

export interface RunnerResolutionPort {
  /** Resolve (and certify) the actor's own runner for the target. */
  resolve(
    actor: ActorContext,
    target: CreationTarget,
    intent: CreationIntent,
  ): Promise<RunnerResolution>;
}

export type RemoteCreationResponse =
  /** `thread` is the runner's parsed JSON response, returned to the client verbatim. */
  | { readonly ok: true; readonly thread: unknown }
  | { readonly ok: false; readonly status: number; readonly message: string };

export interface RemoteThreadCreationPort {
  create(
    runnerId: RunnerId,
    actor: ActorContext,
    intent: CreationIntent,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<RemoteCreationResponse>;
}

export interface ThreadRegistration {
  readonly id: ThreadId;
  readonly projectId: string | null;
  readonly runnerId: RunnerId;
  readonly userId: UserId;
  readonly title?: string;
  readonly model?: string;
  readonly mode?: string;
  readonly branch?: string;
  readonly isScratch: boolean;
}

export interface ThreadRegistryPort {
  register(entry: ThreadRegistration): Promise<void>;
}

export interface ThreadRoutingCachePort {
  remember(threadId: ThreadId, userId: UserId, runnerId: RunnerId): void;
}

export interface CreateThreadPorts {
  readonly runners: RunnerResolutionPort;
  readonly remote: RemoteThreadCreationPort;
  readonly registry: ThreadRegistryPort;
  readonly routingCache: ThreadRoutingCachePort;
}

// ── Fork ─────────────────────────────────────────────────────────

/** `fork` → POST /:id/fork on the runner. `fork-and-rewind` → POST /:id/fork-and-rewind. */
export type ForkVariant = 'fork' | 'fork-and-rewind';

/** The source thread, as loaded and authorized by the owner middleware. */
export interface ForkSource {
  readonly id: ThreadId;
  /** Stored on the forked thread's registration. Null for a scratch source. */
  readonly projectId: string | null;
}

export interface ForkThreadCommand<U, T> {
  readonly actor: Named<U, ActorContext>;
  readonly variant: ForkVariant;
  readonly source: Named<T, OwnershipForkSource>;
  readonly ownership: ThreadOwnedBy<U, T>;
  /** Raw request text, forwarded to the runner byte-for-byte. Never parsed here. */
  readonly body: string;
}

export interface SourceRunnerResolutionPort {
  /** Resolve (and certify) the actor's own runner for the source's project. */
  resolve(actor: ActorContext, projectId: string | null): Promise<RunnerResolution>;
}

export interface RemoteThreadForkPort {
  /**
   * Returns the parsed runner body on success. The error message is already
   * variant-formatted. `projectId` is the source's project (null for a scratch
   * source); the adapter certifies the runner for it before sending.
   */
  fork(
    runnerId: RunnerId,
    actor: ActorContext,
    variant: ForkVariant,
    sourceId: ThreadId,
    body: string,
    projectId: string | null,
  ): Promise<RemoteCreationResponse>;
}

export interface ForkThreadPorts {
  readonly runners: SourceRunnerResolutionPort;
  readonly remote: RemoteThreadForkPort;
  readonly registry: ThreadRegistryPort;
  readonly routingCache: ThreadRoutingCachePort;
}
