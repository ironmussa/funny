import type { InboxItem, RunTriageStatus } from '@funny/shared';
import { Check, RotateCcw, X } from 'lucide-react';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { HighlightText } from '@/components/ui/highlight-text';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { TriCheckbox } from '@/components/ui/tri-checkbox';
import { triageRun } from '@/data/automations/actions';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

import { RunStateDot, runStateLabel } from './RunStateDot';

/** When the run arrived: day and minute (the year too when it is not this
 *  one), so two runs a few minutes apart read differently. */
function formatArrival(when: string, locale: string): string {
  const date = new Date(when);
  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  };
  if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
  return date.toLocaleString(locale, options);
}

/** The quick triage actions a run offers on hover, by its current status. */
function RowActions({ runId, status }: { runId: string; status: RunTriageStatus }) {
  const { t } = useTranslation();
  const act = (next: RunTriageStatus) => (e: MouseEvent) => {
    e.stopPropagation();
    void triageRun(runId, next);
  };
  return (
    // Always laid out, only shown on hover, and no taller than the time's line:
    // appearing never moves the time beside them nor grows the row.
    <div className="invisible flex h-5 items-center gap-0.5 group-focus-within/inbox-row:visible group-hover/inbox-row:visible">
      {status !== 'reviewed' && (
        <TooltipIconButton
          tooltip={t('automationInbox.markReviewed')}
          data-testid={`inbox-row-review-${runId}`}
          onClick={act('reviewed')}
        >
          <Check className="icon-sm" />
        </TooltipIconButton>
      )}
      {status !== 'dismissed' && (
        <TooltipIconButton
          tooltip={t('automationInbox.dismiss')}
          data-testid={`inbox-row-dismiss-${runId}`}
          onClick={act('dismissed')}
        >
          <X className="icon-sm" />
        </TooltipIconButton>
      )}
      {status !== 'pending' && (
        <TooltipIconButton
          tooltip={t('automationInbox.moveToPending')}
          data-testid={`inbox-row-pending-${runId}`}
          onClick={act('pending')}
        >
          <RotateCcw className="icon-sm" />
        </TooltipIconButton>
      )}
    </div>
  );
}

/**
 * One automation run in the inbox, laid out like a thread row of the thread
 * search: a checkbox to select it, a dot in the run's state color, the
 * automation's name, the day and time it arrived (and how long ago). Clicking
 * the row opens the run's thread.
 */
export function InboxRunRow({
  item,
  checked,
  active = false,
  search,
  now,
  onCheck,
  onOpen,
}: {
  item: InboxItem;
  checked: boolean;
  /** Its thread is the one open beside the inbox. */
  active?: boolean;
  search: string;
  now: number;
  /** `shift`: extend the selection from the last checked row. */
  onCheck: (runId: string, shift: boolean) => void;
  onOpen: (thread: InboxItem['thread']) => void;
}) {
  const { t, i18n } = useTranslation();
  const { run, automation, thread } = item;
  const when = run.completedAt ?? run.startedAt;

  return (
    <div
      data-testid={`inbox-row-${run.id}`}
      className={cn(
        'group/inbox-row flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 transition-colors',
        // Same highlight as a thread row of the thread search (`ThreadItem`):
        // hovering a row and its thread being open look alike.
        active ? 'bg-sidebar-selected' : checked ? 'bg-accent/60' : 'hover:bg-sidebar-selected',
      )}
      aria-current={active || undefined}
    >
      <div className="flex h-5 shrink-0 items-center">
        <TriCheckbox
          state={checked ? 'checked' : 'unchecked'}
          aria-label={t('automationInbox.selectRun', { name: automation.name })}
          data-testid={`inbox-row-check-${run.id}`}
          onToggle={(e) => onCheck(run.id, e.shiftKey)}
        />
      </div>

      <button
        type="button"
        data-testid={`inbox-row-open-${run.id}`}
        onClick={() => onOpen(thread)}
        className="focus-visible:ring-ring flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 bg-transparent text-left focus:outline-hidden focus-visible:ring-1"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                <RunStateDot state={run.status} testId={`inbox-row-state-${run.id}`} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{runStateLabel(t, run.status)}</TooltipContent>
          </Tooltip>
          <span className="truncate text-sm font-medium">
            <HighlightText text={automation.name} query={search} />
          </span>
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        {/* A running run has nothing to review yet. */}
        {run.status !== 'running' && <RowActions runId={run.id} status={run.triageStatus} />}
        {when && (
          <span
            className="text-muted-foreground text-right text-xs leading-5 whitespace-nowrap tabular-nums"
            title={new Date(when).toLocaleString(i18n.language)}
            data-testid={`inbox-row-time-${run.id}`}
          >
            {formatArrival(when, i18n.language)}
            <span className="text-muted-foreground/60"> · {timeAgo(when, t, now)}</span>
          </span>
        )}
      </div>
    </div>
  );
}
