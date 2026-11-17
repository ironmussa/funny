import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import { D4CAnimation } from '../D4CAnimation';
import { formatDuration } from './format-duration';

/** Start of the run in ms: the turn's user message, else when the indicator mounted. */
function runStart(startedAt: string | null | undefined, fallback: number) {
  const parsed = startedAt ? new Date(startedAt).getTime() : NaN;
  return Number.isFinite(parsed) && parsed <= Date.now() ? parsed : fallback;
}

function WorkingElapsed({ startedAt }: { startedAt?: string | null }) {
  const { t } = useTranslation();
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(0, now - runStart(startedAt, mountedAt));
  return (
    <span className="text-xs tabular-nums" data-testid="agent-working-elapsed">
      ({formatDuration(elapsed, t)})
    </span>
  );
}

/**
 * The "agent is busy" line under the latest user message, like Claude Code's
 * "Working… (12s)": animation, label and live time since the turn started.
 * Shared by the thread preparation view ("Preparing…") and the live stream
 * ("Agent is working…") so both look and sit the same.
 */
export function AgentWorkingIndicator({
  label,
  startedAt,
  compact = false,
  className,
  'data-testid': testId = 'agent-working-indicator',
}: {
  label: string;
  /** ISO timestamp of the user message that started the turn. */
  startedAt?: string | null;
  compact?: boolean;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className={cn('text-muted-foreground flex items-center gap-2.5 py-1 text-sm', className)}
    >
      <D4CAnimation size={compact ? 'sm' : undefined} />
      <span className="text-xs">{label}</span>
      <WorkingElapsed startedAt={startedAt} />
    </div>
  );
}
