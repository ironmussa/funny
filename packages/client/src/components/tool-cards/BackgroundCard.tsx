import { ChevronRight, Timer } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { CommandOutput } from './CommandOutput';
import { ToolContentArea } from './MobileContentPreview';

const JOB_STATUSES = new Set(['running', 'exited', 'failed', 'killed', 'cancelled']);

/** The job fields a background tool call reports; any of them may be missing. */
interface BackgroundJobInput {
  command?: unknown;
  cwd?: unknown;
  label?: unknown;
  status?: unknown;
  exitCode?: unknown;
}

/** A non-blank string. */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** The job fields the card shows, each null when the call did not report it. */
function jobFields(parsed: BackgroundJobInput) {
  const command = isText(parsed.command) ? parsed.command : null;
  return {
    command,
    cwd: isText(parsed.cwd) ? parsed.cwd : null,
    summary: (isText(parsed.label) ? parsed.label : null) ?? command,
    status: isText(parsed.status) ? parsed.status : null,
    exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
  };
}

function JobStatusBadge({ status, exitCode }: { status: string; exitCode: number | null }) {
  const { t } = useTranslation();
  const failed = status === 'failed' || (exitCode !== null && exitCode !== 0);
  return (
    <Badge
      variant={failed ? 'destructive' : 'secondary'}
      size="xs"
      weight="normal"
      data-testid="background-card-status"
    >
      {JOB_STATUSES.has(status) ? t(`tools.jobStatus.${status}`) : status}
      {exitCode !== null && ` · ${t('tools.backgroundExitCode')} ${exitCode}`}
    </Badge>
  );
}

/**
 * A background job's completion (the `Background` tool call the runtime adds
 * when a job ends): its label, status and exit code in the header, and the
 * command highlighted with its output when expanded.
 */
export function BackgroundCard({
  parsed,
  output,
  hideLabel,
  displayTime,
}: {
  parsed: Record<string, unknown>;
  output?: string;
  hideLabel?: boolean;
  displayTime?: string | null;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { command, cwd, summary, status, exitCode } = jobFields(parsed);

  return (
    <div
      data-expanded={expanded}
      className="tool-card-frame max-w-full overflow-hidden rounded-lg text-sm"
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        data-testid="background-card-toggle"
        className="hover:bg-accent/30 flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs"
      >
        <ChevronRight
          className={cn('icon-xs shrink-0 text-muted-foreground', expanded && 'rotate-90')}
        />
        {!hideLabel && <Timer className="icon-xs text-muted-foreground shrink-0" />}
        {!hideLabel && (
          <span className="text-foreground shrink-0 font-mono font-medium">
            {t('tools.background')}
          </span>
        )}
        {summary && (
          <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
            {summary}
          </span>
        )}
        {status && <JobStatusBadge status={status} exitCode={exitCode} />}
        {displayTime && (
          <span className="text-muted-foreground/50 text-2xs ml-auto shrink-0 tabular-nums">
            {displayTime}
          </span>
        )}
      </button>
      {expanded && command && (
        <ToolContentArea viewportProps={{ className: 'max-h-[50vh] scroll-fade-none' }}>
          {cwd && (
            <div className="text-muted-foreground truncate px-3 pt-2 font-mono text-xs" title={cwd}>
              {cwd}
            </div>
          )}
          <CommandOutput command={command} output={output} />
        </ToolContentArea>
      )}
    </div>
  );
}
