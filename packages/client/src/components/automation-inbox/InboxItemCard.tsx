import type { InboxItem, Project } from '@funny/shared';
import type { KeyboardEvent } from 'react';

import { ThreadTitle } from '@/components/thread/ThreadAttachmentsBadge';
import { Button } from '@/components/ui/button';
import { triageRun } from '@/data/automations/actions';
import { cn } from '@/lib/utils';

interface InboxItemCardProps {
  run: InboxItem['run'];
  automation: InboxItem['automation'];
  thread: InboxItem['thread'];
  itemProject: Project | undefined;
  selected: boolean;
  onSelect: (threadId: string) => void;
  onViewThread: (thread: InboxItem['thread']) => void;
}

type InboxRun = InboxItem['run'];

/** Enter / Space on the card itself (not on a nested button) selects it. */
function isCardActivation(event: KeyboardEvent<HTMLDivElement>) {
  return event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ');
}

function InboxItemHeading({
  automation,
  thread,
  itemProject,
}: Pick<InboxItemCardProps, 'automation' | 'thread' | 'itemProject'>) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium">{automation.name}</p>
      <p className="text-muted-foreground truncate text-xs">
        {itemProject && <span className="font-medium">{itemProject.name} · </span>}
        <ThreadTitle
          as="span"
          title={thread.title}
          projectId={thread.projectId || undefined}
          className="text-xs"
          containerClassName="inline-flex max-w-full align-bottom"
        />
      </p>
    </div>
  );
}

function InboxRunMeta({ run }: { run: InboxRun }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          'text-xs px-1.5 py-0.5 rounded-full',
          run.hasFindings
            ? 'bg-status-warning/10 text-status-warning/80'
            : 'bg-muted text-muted-foreground',
        )}
      >
        {run.hasFindings ? 'Has findings' : 'No findings'}
      </span>
      <span className="text-muted-foreground text-xs">
        {run.completedAt ? new Date(run.completedAt).toLocaleString() : ''}
      </span>
    </div>
  );
}

function TriageButtons({ runId }: { runId: string }) {
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        onClick={(e) => {
          e.stopPropagation();
          void triageRun(runId, 'dismissed');
        }}
      >
        Dismiss
      </Button>
      <Button
        variant="outline"
        size="xs"
        onClick={(e) => {
          e.stopPropagation();
          void triageRun(runId, 'reviewed');
        }}
      >
        Mark Reviewed
      </Button>
    </>
  );
}

export function InboxItemCard({
  run,
  automation,
  thread,
  itemProject,
  selected,
  onSelect,
  onViewThread,
}: InboxItemCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'rounded-lg border bg-card p-4 space-y-3 cursor-pointer transition-colors',
        selected ? 'border-primary/50 bg-accent/30' : 'border-border/50 hover:border-border',
      )}
      onClick={() => onSelect(thread.id)}
      onKeyDown={(event) => {
        if (isCardActivation(event)) {
          event.preventDefault();
          onSelect(thread.id);
        }
      }}
    >
      <div className="flex items-center justify-between">
        <InboxItemHeading automation={automation} thread={thread} itemProject={itemProject} />
        <InboxRunMeta run={run} />
      </div>
      {run.summary && <p className="text-muted-foreground text-xs">{run.summary}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            onViewThread(thread);
          }}
        >
          View Thread
        </Button>
        {run.triageStatus === 'pending' && <TriageButtons runId={run.id} />}
      </div>
    </div>
  );
}
