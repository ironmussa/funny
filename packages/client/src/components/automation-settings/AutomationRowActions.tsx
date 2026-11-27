import type { Automation } from '@funny/shared';
import { Pencil, Trash2, Play, Pause, History, Loader2 } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface RowActionProps {
  /** The accessible name of the button. */
  label: string;
  /** The tooltip's text. */
  tooltip: string;
  testId: string;
  onClick: () => void;
  variant?: ComponentProps<typeof Button>['variant'];
  /** The action's request is waiting for the server's answer. */
  busy?: boolean;
  children: ReactNode;
}

function RowAction({
  label,
  tooltip,
  testId,
  onClick,
  variant = 'muted',
  busy,
  children,
}: RowActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={variant}
          size="icon-sm"
          aria-label={label}
          aria-busy={busy}
          disabled={busy}
          data-testid={testId}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function RunNowAction({
  a,
  triggering,
  onTrigger,
}: {
  a: Automation;
  triggering: boolean;
  onTrigger: (a: Automation) => void;
}) {
  return (
    <RowAction
      label="Run now"
      tooltip={triggering ? 'Starting…' : 'Run Now'}
      testId={`automation-run-${a.id}`}
      variant="ghost-success-soft"
      busy={triggering}
      onClick={() => onTrigger(a)}
    >
      {triggering ? <Loader2 className="icon-sm animate-spin" /> : <Play className="icon-sm" />}
    </RowAction>
  );
}

function ToggleEnabledAction({
  a,
  onToggleEnabled,
}: {
  a: Automation;
  onToggleEnabled: (a: Automation) => void;
}) {
  const label = a.enabled ? 'Pause' : 'Enable';
  const Icon = a.enabled ? Pause : Play;
  return (
    <RowAction
      label={label}
      tooltip={label}
      testId={`automation-toggle-${a.id}`}
      onClick={() => onToggleEnabled(a)}
    >
      <Icon className="icon-sm" />
    </RowAction>
  );
}

/** Edit and delete: not offered for an automation declared in `.funny.json`. */
function OwnAutomationActions({
  a,
  onEdit,
  onDelete,
}: {
  a: Automation;
  onEdit: (a: Automation) => void;
  onDelete: (a: Automation) => void;
}) {
  return (
    <>
      <RowAction
        label="Edit"
        tooltip="Edit"
        testId={`automation-edit-${a.id}`}
        onClick={() => onEdit(a)}
      >
        <Pencil className="icon-sm" />
      </RowAction>
      <RowAction
        label="Delete"
        tooltip="Delete"
        testId={`automation-delete-${a.id}`}
        variant="muted-destructive"
        onClick={() => onDelete(a)}
      >
        <Trash2 className="icon-sm" />
      </RowAction>
    </>
  );
}

interface AutomationRowActionsProps {
  a: Automation;
  onTrigger: (a: Automation) => void;
  onToggleEnabled: (a: Automation) => void;
  onViewRuns: (automationId: string) => void;
  onEdit: (a: Automation) => void;
  onDelete: (a: Automation) => void;
  /** The run-now request is waiting for the server's answer. */
  triggering: boolean;
}

/** The buttons a row shows on hover (and while its run-now request is pending). */
export function AutomationRowActions({
  a,
  onTrigger,
  onToggleEnabled,
  onViewRuns,
  onEdit,
  onDelete,
  triggering,
}: AutomationRowActionsProps) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100',
        triggering && 'opacity-100',
      )}
    >
      <RunNowAction a={a} triggering={triggering} onTrigger={onTrigger} />
      <ToggleEnabledAction a={a} onToggleEnabled={onToggleEnabled} />
      <RowAction
        label="Run history"
        tooltip="Run History"
        testId={`automation-history-${a.id}`}
        onClick={() => onViewRuns(a.id)}
      >
        <History className="icon-sm" />
      </RowAction>
      {a.source !== 'config' && <OwnAutomationActions a={a} onEdit={onEdit} onDelete={onDelete} />}
    </div>
  );
}
