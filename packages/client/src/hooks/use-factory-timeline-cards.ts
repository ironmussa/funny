import { useMemo } from 'react';

import { useFactoryRunOfThread } from '@/data/factory/hooks';
import { factoryTimelineCards, type FactoryTimelineCard } from '@/lib/factory-timeline';
import { useThreadById } from '@/lib/thread-selectors';

const NO_CARDS: FactoryTimelineCard[] = [];

/** A factory thread's run cards with their times (see `lib/factory-timeline.ts`); none for any other thread. */
export function useFactoryTimelineCards(
  threadId: string | undefined,
  agentRunning: boolean,
): FactoryTimelineCard[] {
  const thread = useThreadById(threadId);
  const run = useFactoryRunOfThread(thread);
  const projectId = thread?.projectId;
  return useMemo(
    () =>
      run && projectId && threadId
        ? factoryTimelineCards(run, { projectId, threadId }, agentRunning)
        : NO_CARDS,
    [run, projectId, threadId, agentRunning],
  );
}
