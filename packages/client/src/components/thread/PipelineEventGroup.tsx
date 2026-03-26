/**
 * PipelineEventGroup — Collapsible group that wraps all events from a single
 * pipeline run (from pipeline:started → pipeline:completed).
 * Styled consistently with ToolCallGroup's chevron + badge pattern.
 */

import type { ThreadEvent } from '@funny/shared';
import { ChevronRight, Shield, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

import { GitEventCard } from './GitEventCard';
import { PipelineEventCard } from './PipelineEventCard';

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

/** Derive the pipeline status from the last event in the group */
function getPipelineStatus(events: ThreadEvent[]): {
  label: string;
  icon: typeof Shield;
  running: boolean;
} {
  const last = events[events.length - 1];
  if (last?.type === 'pipeline:completed') {
    const metadata = parseEventData(last.data);
    const status = metadata.status;
    if (status === 'completed') {
      return { label: 'passed', icon: CheckCircle2, running: false };
    }
    if (status === 'failed') {
      return { label: 'failed', icon: XCircle, running: false };
    }
    return { label: 'skipped', icon: Shield, running: false };
  }
  // Pipeline is still in progress
  return { label: 'running', icon: Shield, running: true };
}

export const PipelineEventGroup = memo(function PipelineEventGroup({
  events,
}: {
  events: ThreadEvent[];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const status = getPipelineStatus(events);
  const StatusIcon = status.icon;

  // Use timestamp from first event for the group
  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];
  const timestamp = lastEvent?.createdAt || firstEvent?.createdAt;

  return (
    <div data-testid="pipeline-event-group" className="max-w-full overflow-hidden text-sm">
      {/* Header row — clickable to expand/collapse */}
      <button
        data-testid="pipeline-event-group-toggle"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/30',
          expanded && 'bg-accent/20',
        )}
      >
        <ChevronRight
          className={cn(
            'icon-xs flex-shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        {status.running ? (
          <Loader2 className="icon-xs flex-shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <StatusIcon className="icon-xs flex-shrink-0 text-muted-foreground" />
        )}
        <span className="flex-shrink-0 font-mono font-medium text-foreground">Pipeline</span>
        <span className="font-mono font-medium text-muted-foreground">{status.label}</span>
        <span className="inline-flex items-center justify-center rounded-full bg-muted-foreground/20 px-1.5 text-xs font-medium leading-4 text-muted-foreground">
          {events.length}
        </span>
        {timestamp && (
          <span className="ml-auto shrink-0 text-muted-foreground">{timeAgo(timestamp, t)}</span>
        )}
      </button>

      {/* Expanded content — all pipeline events */}
      {expanded && (
        <div className="space-y-0 border-t border-border/40 pb-1 pt-0.5">
          {events.map((evt) =>
            evt.type.startsWith('git:') ? (
              <GitEventCard key={evt.id} event={evt} />
            ) : (
              <PipelineEventCard key={evt.id} event={evt} />
            ),
          )}
        </div>
      )}
    </div>
  );
});
