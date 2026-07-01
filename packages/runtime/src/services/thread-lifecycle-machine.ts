/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 * @domain aggregate: Thread
 *
 * Server-side lifecycle transitions that involve both thread status and stage.
 */

import type { ThreadStage, ThreadStatus } from '@funny/shared';

export interface ThreadLifecycleState {
  status?: string | null;
  stage?: string | null;
}

export type ThreadLifecycleEvent = { type: 'AGENT_STARTED' };

export interface ThreadLifecycleTransition {
  updates: {
    status?: ThreadStatus;
    stage?: ThreadStage;
  };
  clientStatus?: {
    status: ThreadStatus;
    stage?: ThreadStage;
  };
}

interface LifecycleRule {
  event: ThreadLifecycleEvent['type'];
  statuses: ReadonlySet<string>;
  stages: ReadonlySet<string>;
  transition: ThreadLifecycleTransition;
}

const agentStartCandidateStages = new Set(['backlog', 'planning', 'review']);
const runningStatuses = new Set(['running']);

const lifecycleRules: LifecycleRule[] = [
  {
    event: 'AGENT_STARTED',
    statuses: runningStatuses,
    stages: agentStartCandidateStages,
    transition: {
      updates: { stage: 'in_progress' },
      clientStatus: { status: 'running', stage: 'in_progress' },
    },
  },
];

export function transitionThreadLifecycle(
  state: ThreadLifecycleState,
  event: ThreadLifecycleEvent,
): ThreadLifecycleTransition | null {
  const rule = lifecycleRules.find(
    (candidate) =>
      candidate.event === event.type &&
      candidate.statuses.has(state.status ?? '') &&
      candidate.stages.has(state.stage ?? ''),
  );

  return rule?.transition ?? null;
}
