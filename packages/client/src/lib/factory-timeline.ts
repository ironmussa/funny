/**
 * Where a factory run's cards sit in its thread: the regression proof when it
 * ran, the pipeline's failure (or "no change") when it happened, among the
 * messages like any other event. A card newer than every loaded message stays
 * below the latest turn's status, where it happened.
 */
import type { FactoryApprovalRequest, FactoryRun } from '@funny/shared/contracts/factory';

import { isFactoryRunFailed, isFactoryRunNoChange } from './factory-run-labels';

export type FactoryCardKind = 'proof' | 'failure' | 'approval-request';

export interface FactoryTimelineCard {
  kind: FactoryCardKind;
  /** When it happened; null when the run does not say (shown last). */
  at: string | null;
  projectId: string;
  threadId: string;
  /** The request an `approval-request` card shows. */
  requestId?: string;
}

/** A card's identity in a list: a thread may hold several approval requests. */
export function factoryCardKey(card: Pick<FactoryTimelineCard, 'kind' | 'requestId'>): string {
  return card.requestId ? `${card.kind}-${card.requestId}` : card.kind;
}

/**
 * The cards of what the agent of a thread asked the member to approve
 * (openspec factory-agent-tools): one per request, at the time it was made,
 * and kept once it is answered so the thread records what was asked.
 */
export function approvalRequestCards(
  requests: ReadonlyArray<Pick<FactoryApprovalRequest, 'id' | 'createdAt' | 'threadId'>>,
  ids: { projectId: string; threadId: string },
): FactoryTimelineCard[] {
  return requests
    .flatMap((request) =>
      request.threadId === ids.threadId
        ? [
            {
              kind: 'approval-request' as const,
              at: request.createdAt,
              requestId: request.id,
              ...ids,
            },
          ]
        : [],
    )
    .sort((a, b) => a.at.localeCompare(b.at));
}

type CardRun = Pick<
  FactoryRun,
  'state' | 'failureReason' | 'completedAt' | 'regressionProof' | 'stepTimings'
>;

/** When the run's pipeline stopped: its end, else the last step that failed (a parked run). */
function failureTime(run: CardRun): string | null {
  if (run.completedAt) return run.completedAt;
  const finished = (run.stepTimings ?? []).filter((step) => step.finishedAt);
  const failed = finished.filter((step) => step.status === 'failed');
  const last = (failed.length > 0 ? failed : finished).at(-1);
  return last?.finishedAt ?? null;
}

/**
 * The cards a factory thread shows for its run. The failure card is left out
 * while the agent works on the thread again (a take-over): its own status shows.
 */
export function factoryTimelineCards(
  run: CardRun | null | undefined,
  ids: { projectId: string; threadId: string },
  agentRunning: boolean,
): FactoryTimelineCard[] {
  if (!run) return [];
  const cards: FactoryTimelineCard[] = [];
  if (run.regressionProof) cards.push({ kind: 'proof', at: run.regressionProof.ranAt, ...ids });
  if (!agentRunning && (isFactoryRunFailed(run) || isFactoryRunNoChange(run))) {
    cards.push({ kind: 'failure', at: failureTime(run), ...ids });
  }
  return cards;
}

/** The newest timestamp among the loaded messages and their tool calls, or ''. */
function latestMessageTime(messages: ReadonlyArray<MessageTimes>): string {
  let latest = '';
  for (const msg of messages) {
    if (msg.timestamp && msg.timestamp > latest) latest = msg.timestamp;
    for (const tc of msg.toolCalls ?? []) {
      if (tc.timestamp && tc.timestamp > latest) latest = tc.timestamp;
    }
  }
  return latest;
}

interface MessageTimes {
  timestamp?: string;
  toolCalls?: ReadonlyArray<{ timestamp?: string }>;
}

/**
 * Whether a card goes after the latest turn's status rather than among the
 * messages: nothing loaded happened after it (or its time is unknown).
 */
export function isTrailingFactoryCard(
  card: Pick<FactoryTimelineCard, 'at'>,
  messages: ReadonlyArray<MessageTimes>,
): boolean {
  return !card.at || card.at >= latestMessageTime(messages);
}
