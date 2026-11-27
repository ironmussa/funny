import type { AutomationRun } from '@funny/shared';
import type { TFunction } from 'i18next';

import { cn } from '@/lib/utils';

const DOT_CLASS: Record<AutomationRun['status'], string> = {
  running: 'bg-status-info animate-pulse',
  completed: 'bg-status-success',
  failed: 'bg-status-error',
  archived: 'bg-muted-foreground',
};

/** The run state's label, as the row's tooltip and the state filter show it. */
export function runStateLabel(t: TFunction, state: AutomationRun['status']): string {
  return t(`automationInbox.runState.${state}`);
}

/** A dot in the run state's color: blue and pulsing while it runs, green done, red failed. */
export function RunStateDot({
  state,
  className,
  testId,
}: {
  state: AutomationRun['status'];
  className?: string;
  testId?: string;
}) {
  return (
    <span
      className={cn('block size-2 shrink-0 rounded-full', DOT_CLASS[state], className)}
      data-testid={testId}
      data-state={state}
    />
  );
}
