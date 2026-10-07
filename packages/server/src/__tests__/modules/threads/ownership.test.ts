import { describe, expect, test } from 'bun:test';

import { withForkInputs } from '../../../modules/threads/domain/fork-input.js';
import { authenticatedUserId, authorizedThreadId } from '../../../modules/threads/domain/ids.js';
import { threadOwnedBy } from '../../../modules/threads/domain/proofs/thread-owned-by.js';

describe('fork ownership evidence', () => {
  test('only the source owner receives evidence', () => {
    const source = { id: authorizedThreadId('thread-1'), projectId: 'project-1', ownerId: 'owner' };
    for (const userId of ['owner', 'viewer', 'steerer', 'stranger']) {
      withForkInputs({ userId: authenticatedUserId(userId) }, source, (actor, namedSource) => {
        expect(threadOwnedBy(actor, namedSource)?.kind ?? null).toBe(
          userId === 'owner' ? 'ThreadOwnedBy' : null,
        );
      });
    }
  });

  test('retained aliases cannot mutate checked actor or source snapshots', () => {
    const actorInput = { userId: authenticatedUserId('owner'), organizationId: 'org-1' };
    const sourceInput = {
      id: authorizedThreadId('thread-1'),
      projectId: 'project-1',
      ownerId: 'owner',
    };
    withForkInputs(actorInput, sourceInput, (actor, source) => {
      expect(threadOwnedBy(actor, source)).not.toBeNull();
      actorInput.userId = authenticatedUserId('other');
      actorInput.organizationId = 'org-2';
      sourceInput.id = authorizedThreadId('thread-2');
      sourceInput.projectId = 'project-2';
      sourceInput.ownerId = 'other';
      expect(actor.value).toEqual({
        userId: authenticatedUserId('owner'),
        organizationId: 'org-1',
      });
      expect(source.value).toEqual({
        id: authorizedThreadId('thread-1'),
        projectId: 'project-1',
        ownerId: 'owner',
      });
      expect(Object.isFrozen(actor.value)).toBe(true);
      expect(Object.isFrozen(source.value)).toBe(true);
      expect(threadOwnedBy(actor, source)).not.toBeNull();
    });
  });
});
