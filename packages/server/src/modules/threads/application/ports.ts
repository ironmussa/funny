/**
 * Ports for thread creation: the effects the use case needs, and nothing more.
 *
 * Ownership:
 *  - RunnerResolutionPort: the requesting user's runner selection
 *    (runner-manager / runner-resolver). It must never return another user's runner.
 *  - RemoteThreadCreationPort: the signed identity forwarding plus the runner
 *    request transport (`RunnerRequestPort`). Headers, secrets, and JSON live here.
 *  - ThreadRegistryPort: the central DB thread registry (`thread-registry`).
 *  - ThreadRoutingCachePort: the in-memory thread→runner routing cache (`runner-resolver`).
 *
 * Adapters may throw. The use case maps those throws to the same results the
 * legacy handler produced (see create-thread.ts).
 */

import type { CreationTarget } from '../domain/creation-target.js';
import type { RunnerId, ThreadId, UserId } from '../domain/ids.js';

/** `normal` → POST /api/threads on the runner. `idle` → POST /api/threads/idle. */
export type CreationIntent = 'normal' | 'idle';

/** Authenticated caller. Always taken from the session, never from the body. */
export interface ActorContext {
  readonly userId: UserId;
  readonly organizationId?: string;
  readonly organizationName?: string;
  readonly role?: string;
}

export interface CreateThreadCommand {
  readonly actor: ActorContext;
  readonly intent: CreationIntent;
  /** Legacy permissive creation envelope (already parsed as a JSON object). */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RunnerResolutionPort {
  /** Resolve the actor's own runner for the target. Returns null when none is online. */
  resolve(
    actor: ActorContext,
    target: CreationTarget,
    intent: CreationIntent,
  ): Promise<RunnerId | null>;
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
