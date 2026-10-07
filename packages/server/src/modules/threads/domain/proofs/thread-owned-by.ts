import { defineProof, type Named, type Proof } from '@gdp-ts/core';

import type { ActorContext, OwnershipForkSource } from '../fork-input.js';

const ownership = defineProof('ThreadOwnedBy');

export interface ThreadOwnedBy<U, T> extends Proof<'ThreadOwnedBy', [U, T]> {}

/** Inputs originate from the authenticated session and the loaded source row. */
export function threadOwnedBy<U, T>(
  actor: Named<U, ActorContext>,
  source: Named<T, OwnershipForkSource>,
): ThreadOwnedBy<U, T> | null {
  return actor.value.userId === source.value.ownerId ? ownership.prove(actor, source) : null;
}
