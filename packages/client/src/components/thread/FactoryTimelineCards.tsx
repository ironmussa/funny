/**
 * A factory run's cards in its thread (proof, failure), placed by time: the
 * message list renders the ones with messages after them, the stream renders
 * the newest below the latest turn's status (see `lib/factory-timeline.ts`).
 */
import { useFactoryTimelineCards } from '@/hooks/use-factory-timeline-cards';
import { isTrailingFactoryCard, type FactoryTimelineCard } from '@/lib/factory-timeline';

import { FactoryRunFailure } from './FactoryRunFailureCard';
import { FactoryRunProof } from './FactoryRunProofCard';

export function FactoryTimelineCardView({ card }: { card: FactoryTimelineCard }) {
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
  return trailing.map((card) => <FactoryTimelineCardView key={card.kind} card={card} />);
}
