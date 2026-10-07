// Compile only. This file is never executed by the runtime test runner.
import type { Named, Proof } from '@gdp-ts/core';

import {
  authenticatedUserId,
  authorizedThreadId,
  threadOwnedBy,
  withForkInputs,
  type ActorContext,
  type ForkThread,
  type OwnershipForkSource,
  type ThreadOwnedBy,
} from '../src/modules/threads/index.js';

declare const fork: ForkThread;
const actorInput = { userId: authenticatedUserId('owner') };
const sourceInput = { id: authorizedThreadId('source'), projectId: 'project', ownerId: 'owner' };

withForkInputs(actorInput, sourceInput, (actor, source) => {
  const ownership = threadOwnedBy(actor, source);
  if (!ownership) throw new Error('owner expected');
  const command = { actor, source, ownership, variant: 'fork' as const, body: '{}' };
  fork(command);
  fork({ ...command, variant: 'fork-and-rewind' });
  // @ts-expect-error Ownership evidence is mandatory.
  fork({ actor, source, variant: 'fork', body: '{}' });
  // @ts-expect-error A raw actor cannot replace the checked actor.
  fork({ ...command, actor: actorInput });
  // @ts-expect-error A raw source cannot replace the checked source.
  fork({ ...command, source: sourceInput });
  // @ts-expect-error An unchecked (possibly null) result is not evidence.
  fork({ ...command, ownership: threadOwnedBy(actor, source) });

  withForkInputs(actorInput, sourceInput, (otherActor, otherSource) => {
    // @ts-expect-error Even equal runtime actor IDs in a different scope are distinct names.
    fork({ ...command, actor: otherActor });
    // @ts-expect-error Evidence belongs to the original source name.
    fork({ ...command, source: otherSource });
    const otherOwnership = threadOwnedBy(otherActor, otherSource);
    if (!otherOwnership) throw new Error('owner expected');
    // @ts-expect-error Evidence cannot be substituted from a different scope.
    fork({ ...command, ownership: otherOwnership });
  });
});

export function reversedSubjects<U, T>(
  actor: Named<U, ActorContext>,
  source: Named<T, OwnershipForkSource>,
  reversed: ThreadOwnedBy<T, U>,
) {
  // @ts-expect-error Evidence about (source, actor) is not evidence about (actor, source).
  fork({ actor, source, ownership: reversed, variant: 'fork', body: '{}' });
}

export function wrongKind<U, T>(
  actor: Named<U, ActorContext>,
  source: Named<T, OwnershipForkSource>,
  view: Proof<'ThreadView', [U, T]>,
) {
  // @ts-expect-error Viewing is not ownership.
  fork({ actor, source, ownership: view, variant: 'fork', body: '{}' });
}

// @ts-expect-error Evidence cannot escape its naming callback.
withForkInputs(actorInput, sourceInput, (actor, source) => threadOwnedBy(actor, source));
// @ts-expect-error Named sources cannot escape wrapped in another object either.
withForkInputs(actorInput, sourceInput, (_actor, source) => ({ source }));
