/**
 * A thread's factory cards (a run's proof and failure, and what the agent asked
 * the member to approve), placed by time: the
 * message list renders the ones with messages after them, the stream renders
 * the newest below the latest turn's status (see `lib/factory-timeline.ts`).
 */
import { useFactoryTimelineCards } from '@/hooks/use-factory-timeline-cards';
import {
  factoryCardKey,
  isTrailingFactoryCard,
  type FactoryTimelineCard,
} from '@/lib/factory-timeline';

import { FactoryApprovalRequestCard } from './FactoryApprovalRequestCard';
import { FactoryRunFailure } from './FactoryRunFailureCard';
import { FactoryRunProof } from './FactoryRunProofCard';

export function FactoryTimelineCardView({ card }: { card: FactoryTimelineCard }) {
  if (card.kind === 'approval-request') {
    return card.requestId ? (
      <FactoryApprovalRequestCard projectId={card.projectId} requestId={card.requestId} />
    ) : null;
  }
  return card.kind === 'proof' ? (
    <FactoryRunProof projectId={card.projectId} threadId={card.threadId} />
  ) : (
    <FactoryRunFailure projectId={card.projectId} threadId={card.threadId} />
  );
}

/** The run's cards newer than every loaded message, in time order. */
export function TrailingFactoryCards({
  threadId,
  messages,
  agentRunning,
}: {
  threadId?: string;
  messages: ReadonlyArray<{
    timestamp?: string;
    toolCalls?: ReadonlyArray<{ timestamp?: string }>;
  }>;
  /** The agent is working on the thread again (a take-over): its own status shows. */
  agentRunning: boolean;
}) {
  const cards = useFactoryTimelineCards(threadId, agentRunning);
  const trailing = cards
    .filter((card) => isTrailingFactoryCard(card, messages))
    .sort((a, b) => (a.at ?? '￿').localeCompare(b.at ?? '￿'));
  return trailing.map((card) => <FactoryTimelineCardView key={factoryCardKey(card)} card={card} />);
}
