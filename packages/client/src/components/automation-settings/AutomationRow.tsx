import type { Automation, AutomationRun } from '@funny/shared';
import { Pencil, Trash2, Play, Pause, History } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { getScheduleLabel } from './automation-form';

interface AutomationRunHistoryProps {
  runs: AutomationRun[];
  onOpenThread: (threadId: string) => void;
  onClose: () => void;
}

function AutomationRunHistory({ runs, onOpenThread, onClose }: AutomationRunHistoryProps) {
  return (
    <div className="ml-4 space-y-1">
      {runs.length === 0 ? (
        <p className="text-muted-foreground py-2 pl-2 text-xs">No runs yet.</p>
      ) : (
        runs.slice(0, 10).map((run) => (
          <div
            key={run.id}
            className="border-border/30 flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-xs"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full shrink-0',
                  // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
                  run.status === 'running'
                    ? 'bg-status-info animate-pulse'
                    : run.status === 'completed'
                      ? 'bg-status-success/80'
                      : run.status === 'failed'
                        ? 'bg-status-error'
                        : 'bg-muted-foreground/30',
                )}
              />
              <span className="text-muted-foreground truncate">
                {new Date(run.startedAt).toLocaleString()}
              </span>
              <span className="text-muted-foreground/70">{run.status}</span>
            </div>
            <Button
              variant="ghost"
              size="2xs"
              onClick={() => {
                onOpenThread(run.threadId);
              }}
            >
              View
            </Button>
          </div>
        ))
      )}
      <Button variant="ghost" size="xs" className="h-5 w-full" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

function AutomationSummary({ a }: { a: Automation }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'h-2 w-2 rounded-full shrink-0',
            a.enabled ? 'bg-status-success/80' : 'bg-muted-foreground/30',
          )}
        />
        <span className="truncate text-sm font-medium">{a.name}</span>
        <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-xs">
          {getScheduleLabel(a.schedule)}
        </span>
        <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-1.5 py-0.5 text-xs">
          {a.model}
        </span>
        {a.source === 'config' && (
          <span
            className="bg-status-info/15 text-status-info shrink-0 rounded-full px-1.5 py-0.5 text-xs"
            data-testid={`automation-config-badge-${a.id}`}
          >
            .funny.json
          </span>
        )}
      </div>
      <p className="text-muted-foreground mt-0.5 truncate pl-4 text-xs">{a.prompt}</p>
      {a.lastRunAt && (
        <p className="text-muted-foreground/70 mt-0.5 pl-4 text-xs">
          Last run: {new Date(a.lastRunAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}

interface AutomationRowProps {
  a: Automation;
  runsOpen: boolean;
  runs: AutomationRun[];
  onTrigger: (a: Automation) => void;
  onToggleEnabled: (a: Automation) => void;
  onViewRuns: (automationId: string) => void;
  onEdit: (a: Automation) => void;
  onDelete: (a: Automation) => void;
  onOpenThread: (threadId: string) => void;
  onCloseRuns: () => void;
}

export function AutomationRow({
  a,
  runsOpen,
  runs,
  onTrigger,
  onToggleEnabled,
  onViewRuns,
  onEdit,
  onDelete,
  onOpenThread,
  onCloseRuns,
}: AutomationRowProps) {
  return (
    <div className="space-y-1">
      <div className="settings-item-card group flex items-center justify-between gap-3">
        <AutomationSummary a={a} />

        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost-success-soft" size="icon-sm" onClick={() => onTrigger(a)}>
                <Play className="icon-sm" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run Now</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="muted" size="icon-sm" onClick={() => onToggleEnabled(a)}>
                {a.enabled ? <Pause className="icon-sm" /> : <Play className="icon-sm" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{a.enabled ? 'Pause' : 'Enable'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="muted" size="icon-sm" onClick={() => onViewRuns(a.id)}>
                <History className="icon-sm" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run History</TooltipContent>
          </Tooltip>
          {a.source !== 'config' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="muted" size="icon-sm" onClick={() => onEdit(a)}>
                  <Pencil className="icon-sm" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
          )}
          {a.source !== 'config' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="muted-destructive" size="icon-sm" onClick={() => onDelete(a)}>
                  <Trash2 className="icon-sm" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Inline run history */}
      {runsOpen && (
        <AutomationRunHistory runs={runs} onOpenThread={onOpenThread} onClose={onCloseRuns} />
      )}
    </div>
  );
}
