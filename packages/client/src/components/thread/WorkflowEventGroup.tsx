/**
 * WorkflowEventGroup — Collapsible group that wraps all events from a single
 * git workflow run (workflow:started → git events → workflow:completed).
 * Styled consistently with PipelineEventGroup's chevron + badge pattern.
 */

import type { ThreadEvent } from '@funny/shared';
import { ChevronRight, GitCommit, CheckCircle2, XCircle, Loader2, Check, X } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/shallow';

import { SubItemsList } from '@/components/GitProgressModal';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { GitProgressStep } from '@/lib/git-progress-types';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useCommitProgressStore } from '@/stores/commit-progress-store';

import { WorkflowEventCard } from './WorkflowEventCard';

function parseEventData(data: string | Record<string, unknown>): Record<string, any> {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
  return data as Record<string, any>;
}

/** Labels for workflow actions */
const ACTION_LABELS: Record<string, string> = {
  commit: 'Commit',
  amend: 'Amend',
  'commit-push': 'Commit & Push',
  'commit-pr': 'Commit & PR',
  'commit-merge': 'Commit & Merge',
  push: 'Push',
  merge: 'Merge',
  'create-pr': 'Create PR',
};

/** Derive the workflow status from the events */
function getWorkflowStatus(events: ThreadEvent[]): {
  label: string;
  action: string;
  icon: typeof GitCommit;
  running: boolean;
  error?: string;
} {
  // Find the workflow:started event for the action label
  const startedEvent = events.find((e) => e.type === 'workflow:started');
  const completedEvent = events.find((e) => e.type === 'workflow:completed');
  const startData = startedEvent ? parseEventData(startedEvent.data) : {};
  const action = startData.action || '';
  const actionLabel = ACTION_LABELS[action] || action;

  if (completedEvent) {
    const metadata = parseEventData(completedEvent.data);
    if (metadata.status === 'completed') {
      return { label: 'completed', action: actionLabel, icon: CheckCircle2, running: false };
    }
    return {
      label: 'failed',
      action: actionLabel,
      icon: XCircle,
      running: false,
      error: metadata.error as string | undefined,
    };
  }

  return { label: 'running', action: actionLabel, icon: GitCommit, running: true };
}

/** Stable empty result — avoids creating new references on every selector call */
const EMPTY_PROGRESS: { stepLabel: null; steps: GitProgressStep[] } = {
  stepLabel: null,
  steps: [],
};

/** Get active progress data from the commit progress store for a workflow */
function useActiveProgress(
  workflowId: string | undefined,
  isRunning: boolean,
): {
  stepLabel: string | null;
  steps: GitProgressStep[];
} {
  return useCommitProgressStore(
    useShallow((state) => {
      if (!isRunning || !workflowId) return EMPTY_PROGRESS;
      const entries = Object.values(state.activeCommits);
      const entry = entries.find((e) => e.workflowId === workflowId);
      if (!entry) return EMPTY_PROGRESS;
      const runningStep = entry.steps.find((s) => s.status === 'running');
      return { stepLabel: runningStep?.label ?? null, steps: entry.steps };
    }),
  );
}

/** Step status icon for live progress */
function StepStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'running':
      return <Loader2 className="icon-xs text-muted-foreground animate-spin" />;
    case 'completed':
      return <Check className="icon-xs text-muted-foreground" />;
    case 'failed':
      return <X className="icon-xs text-destructive" />;
    default:
      return null;
  }
}

/** Live progress step row — only rendered for non-pending steps */
function LiveStepRow({ step }: { step: GitProgressStep }) {
  return (
    <div className="flex w-full items-start gap-2 px-3 py-1 text-xs">
      <div className="mt-0.5 shrink-0">
        <StepStatusIcon status={step.status} />
      </div>
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            'font-mono text-muted-foreground',
            step.status === 'running' && 'font-medium text-foreground',
          )}
        >
          {step.label}
        </span>
        {step.subItems && step.subItems.length > 0 && (
          <SubItemsList subItems={step.subItems} parentStatus={step.status} />
        )}
        {step.error && !(step.subItems && step.subItems.length > 0) && (
          <div className="text-destructive min-w-0 truncate">{step.error}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Map from progress step IDs to the event types they correspond to.
 * A completed step is "covered" if a persisted event of the mapped type exists.
 */
const STEP_TO_EVENT_TYPES: Record<string, string[]> = {
  unstage: ['git:unstage'],
  stage: ['git:stage'],
  hooks: ['workflow:hooks'],
  commit: ['git:commit'],
  review: ['workflow:review'],
  fix: ['workflow:fix'],
  push: ['git:push'],
  pr: ['workflow:pr'],
  merge: ['git:merge'],
};

/** Check if a progress step is already represented by a persisted event */
function isStepCoveredByEvent(stepId: string, eventTypes: Set<string>): boolean {
  const mapped = STEP_TO_EVENT_TYPES[stepId];
  if (!mapped) return false;
  return mapped.some((t) => eventTypes.has(t));
}

export const WorkflowEventGroup = memo(function WorkflowEventGroup({
  events,
}: {
  events: ThreadEvent[];
}) {
  const { t } = useTranslation();
  const status = getWorkflowStatus(events);
  const [expanded, setExpanded] = useState(status.running || !!status.error);
  const StatusIcon = status.icon;

  // Extract workflowId from the started event
  const startedEvent = events.find((e) => e.type === 'workflow:started');
  const startData = startedEvent ? parseEventData(startedEvent.data) : {};
  const workflowId = startData.workflowId as string | undefined;

  const activeProgress = useActiveProgress(workflowId, status.running);

  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];
  const timestamp = lastEvent?.createdAt || firstEvent?.createdAt;

  // Don't count workflow:started and workflow:completed in the badge count
  const innerEvents = events.filter(
    (e) => e.type !== 'workflow:started' && e.type !== 'workflow:completed',
  );

  // Count: persisted events + remaining non-pending uncovered progress steps
  const coveredTypesForCount = new Set(innerEvents.map((e) => e.type));
  const uncoveredSteps = status.running
    ? activeProgress.steps.filter(
        (s) => s.status !== 'pending' && !isStepCoveredByEvent(s.id, coveredTypesForCount),
      )
    : [];
  const badgeCount = innerEvents.length + uncoveredSteps.length;

  return (
    <div
      data-testid="workflow-event-group"
      className="border-border max-w-full overflow-hidden rounded-lg border text-sm"
    >
      {/* Header row — clickable to expand/collapse */}
      <button
        type="button"
        data-testid="workflow-event-group-toggle"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs hover:bg-accent/30',
          expanded && 'bg-accent/20',
        )}
      >
        <ChevronRight
          className={cn('icon-xs shrink-0 text-muted-foreground', expanded && 'rotate-90')}
        />
        {status.running ? (
          <Loader2 className="icon-xs text-muted-foreground shrink-0 animate-spin" />
        ) : (
          <StatusIcon className="icon-xs text-muted-foreground shrink-0" />
        )}
        <span className="text-foreground shrink-0 font-mono font-medium">
          {status.action || 'Workflow'}
        </span>
        <span
          className={cn(
            'font-mono font-medium',
            status.label === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {status.label}
        </span>
        {activeProgress.stepLabel && (
          <span className="text-muted-foreground/70 truncate font-mono">
            : {activeProgress.stepLabel}
          </span>
        )}
        {badgeCount > 0 && (
          <span className="bg-muted-foreground/20 text-muted-foreground inline-flex items-center justify-center rounded-full px-1.5 text-xs leading-4 font-medium">
            {badgeCount}
          </span>
        )}
        {timestamp && (
          <span className="thread-timestamp text-muted-foreground/50 ml-auto">
            {timeAgo(timestamp, t)}
          </span>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-border/40 space-y-0 border-t pt-0.5 pb-1">
          {status.running && activeProgress.steps.length > 0 ? (
            <>
              {/* Show persisted detail events that have arrived so far */}
              {innerEvents.map((evt) => (
                <WorkflowEventCard key={evt.id} event={evt} />
              ))}
              {/* Then show remaining in-progress/completed/failed steps not yet covered by a persisted event.
                  Pending steps are hidden — they represent future steps that may not execute. */}
              {uncoveredSteps.map((step) => (
                <LiveStepRow key={step.id} step={step} />
              ))}
            </>
          ) : (
            <>
              {innerEvents.map((evt) => (
                <WorkflowEventCard key={evt.id} event={evt} />
              ))}
              {status.error && innerEvents.length === 0 && (
                <div className="px-3 py-1.5">
                  <ScrollArea className="bg-destructive/5 max-h-40 rounded">
                    <pre className="text-destructive/80 p-2 font-mono text-[11px] wrap-break-word whitespace-pre-wrap">
                      {status.error}
                    </pre>
                  </ScrollArea>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});
