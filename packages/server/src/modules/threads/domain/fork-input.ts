import { name, type Named } from '@gdp-ts/core';

import type { ThreadId, UserId } from './ids.js';

/** Authenticated caller. Always taken from the session, never from the body. */
export interface ActorContext {
  readonly userId: UserId;
  readonly organizationId?: string;
  readonly organizationName?: string;
  readonly role?: string;
}

/** Authoritative source row; never constructed from request body fields. */
export interface OwnershipForkSource {
  readonly id: ThreadId;
  readonly projectId: string | null;
  readonly ownerId: string;
}

/** Copy before freezing so aliases held by callers cannot change checked values. */
export function withForkInputs<R>(
  actor: ActorContext,
  source: OwnershipForkSource,
  run: <U, T>(actor: Named<U, ActorContext>, source: Named<T, OwnershipForkSource>) => R,
): R {
  return name(Object.freeze({ ...actor }), Object.freeze({ ...source }), run);
}
