import { useMemo } from 'react';

import {
  useFactoryApprovalRequests,
  useFactoryRunOfThread,
  useHasFactory,
} from '@/data/factory/hooks';
import {
  approvalRequestCards,
  factoryTimelineCards,
  type FactoryTimelineCard,
} from '@/lib/factory-timeline';
import { useThreadById } from '@/lib/thread-selectors';
import { canDoGitOps, isFactoryThread } from '@/lib/thread-variant';

const NO_CARDS: FactoryTimelineCard[] = [];

/**
 * The factory cards of a thread with their times (see `lib/factory-timeline.ts`):
 * a factory thread's run cards, and in any other project thread what its agent
 * asked the member to approve. A thread with neither answers the same empty list.
 */
export function useFactoryTimelineCards(
  threadId: string | undefined,
  agentRunning: boolean,
): FactoryTimelineCard[] {
  const thread = useThreadById(threadId);
  const run = useFactoryRunOfThread(thread);
  const projectId = thread?.projectId;
  // A scratch thread has no project, and a factory thread cannot ask. Only a
  // member with a factory here is asked anything: nobody else polls.
  const asksHere = !!thread && canDoGitOps(thread) && !isFactoryThread(thread);
  const askProject = asksHere && projectId ? projectId : undefined;
  const hasFactory = useHasFactory(askProject);
  const requests = useFactoryApprovalRequests(askProject, hasFactory);
  return useMemo(() => {
    if (!projectId || !threadId) return NO_CARDS;
    const ids = { projectId, threadId };
    const cards = [
      ...(run ? factoryTimelineCards(run, ids, agentRunning) : []),
      ...approvalRequestCards(requests ?? [], ids),
    ];
    return cards.length > 0 ? cards : NO_CARDS;
  }, [run, requests, projectId, threadId, agentRunning]);
}
