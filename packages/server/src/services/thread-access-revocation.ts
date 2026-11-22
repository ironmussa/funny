/**
 * Live revocation of thread access (issue #202).
 *
 * A socket's view of a thread is checked once, at `thread:open`; afterwards it
 * stays in the thread's stream and presence rooms until something evicts it.
 * Besides ownership, the only way to view another user's thread is an explicit
 * share, and a share can only be granted to a member of the thread's project
 * (`routes/thread-shares.ts`). So when a member leaves or is removed from a
 * project, their shares on that project's threads go with the membership: the
 * grants are deleted, their sockets leave those threads' rooms, and their
 * client is told to drop the threads — the same steps as revoking one share.
 */

import { create } from '@bufbuild/protobuf';
import { DeliveryClass, DeliveryMetadataSchema } from '@funny/shared/browser-v1/common';
import { ApplicationEventSchema } from '@funny/shared/browser-v1/events';
import { THREAD_SHARE_REVOKED_EVENT } from '@funny/shared/socket-events';

import { repos } from '../db/repos.js';
import { log } from '../lib/logger.js';
import type { BrowserEventSink } from './runner-ports.js';

/** Tell one user's clients that a thread was shared with / unshared from them. */
export function publishShareEvent(
  sink: Pick<BrowserEventSink, 'publish'> | undefined,
  targetUserId: string,
  eventType: string,
  threadId: string,
): void {
  sink?.publish({
    scope: { kind: 'user', userId: targetUserId },
    logicalType: eventType,
    trafficClass: 'events',
    delivery: { class: 'snapshot-recoverable' },
    legacyEvent: { type: eventType, threadId },
    browserV1: create(ApplicationEventSchema, {
      delivery: create(DeliveryMetadataSchema, {
        deliveryClass: DeliveryClass.SNAPSHOT_RECOVERABLE,
      }),
      payload: {
        case: 'user',
        value: { eventType, data: { threadId } },
      },
    }),
  });
}

/**
 * Revoke every share `userId` holds on a thread of `projectId`, evicting their
 * live sockets from those threads. Their own threads are untouched. Returns
 * the thread ids whose share was revoked.
 */
export async function revokeProjectThreadShares(
  sink: Pick<BrowserEventSink, 'evictFromThread' | 'publish'> | undefined,
  userId: string,
  projectId: string,
): Promise<string[]> {
  const shareRepo = repos.threadShares();
  const shared = (await shareRepo.listThreadsSharedWithUser(userId)) as {
    id: string;
    projectId: string | null;
    userId: string;
  }[];
  const threadIds = shared
    .filter((t) => t.projectId === projectId && t.userId !== userId)
    .map((t) => t.id);

  for (const threadId of threadIds) {
    await shareRepo.deleteShare(threadId, userId);
    sink?.evictFromThread(userId, threadId);
    publishShareEvent(sink, userId, THREAD_SHARE_REVOKED_EVENT, threadId);
  }
  if (threadIds.length > 0) {
    log.info('Revoked thread shares after project member removal', {
      namespace: 'thread-access',
      projectId,
      userId,
      threadCount: threadIds.length,
    });
  }
  return threadIds;
}
