import type { ContextBreakdown } from '@funny/shared';

import { AgentAccountSummary } from '@/components/thread/AgentAccountSummary';
import { ContextBreakdownPanel, formatTokens } from '@/components/thread/ContextBreakdownPanel';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { useThreadAgentAccount } from '@/data/agent-account/hooks';
import { cn } from '@/lib/utils';

interface Props {
  pct: number;
  usedTokens?: number;
  maxTokens?: number;
  /** End-of-turn per-category snapshot; shown in the hover card when present. */
  breakdown?: ContextBreakdown;
  onCompact?: () => void;
  disabled?: boolean;
  /** The thread whose account (profile, login, plan usage) heads the card. */
  threadId?: string;
  /** The thread's recorded execution profile, used before a run reports its account. */
  agentProfileId?: string | null;
  agentProfileName?: string | null;
}

const SIZE = 12;
const STROKE = 1.25;
const RADIUS = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * RADIUS;

/** Ring color: red past 80 % used, amber past 60 %. */
function ringColor(clamped: number): string {
  if (clamped > 80) return 'stroke-status-error';
  if (clamped > 60) return 'stroke-status-warning';
  return 'stroke-muted-foreground';
}

/** The used fraction as a ring around an empty track. */
function UsageRing({ clamped }: { clamped: number }) {
  const dash = (clamped / 100) * CIRC;
  return (
    <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="shrink-0 -rotate-90">
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        strokeWidth={STROKE}
        className="stroke-muted"
      />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${CIRC}`}
        className={ringColor(clamped)}
      />
    </svg>
  );
}

/** Tokens used and left, when both counts are known. */
function TokenLine({ usedTokens, maxTokens }: { usedTokens?: number; maxTokens?: number }) {
  if (typeof usedTokens !== 'number' || typeof maxTokens !== 'number' || maxTokens <= 0) {
    return null;
  }
  return (
    <p className="text-muted-foreground mt-1 text-xs">
      {formatTokens(usedTokens)} / {formatTokens(maxTokens)} tokens used ·{' '}
      {formatTokens(Math.max(0, maxTokens - usedTokens))} left
    </p>
  );
}

export function ContextUsageRing({
  pct,
  usedTokens,
  maxTokens,
  breakdown,
  onCompact,
  disabled,
  threadId,
  agentProfileId,
  agentProfileName,
}: Props) {
  const account = useThreadAgentAccount(threadId, agentProfileId);
  const clamped = Math.max(0, Math.min(100, pct));
  const remaining = Math.max(0, Math.round(100 - clamped));

  return (
    <HoverCard openDelay={150} closeDelay={50}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          data-testid="prompt-context-pct"
          aria-label={`Context: ${Math.round(clamped)}% used. Click to compact.`}
          disabled={disabled}
          onClick={onCompact}
          className={cn(
            'mr-1 flex h-6 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-compact text-muted-foreground hover:bg-muted',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          <UsageRing clamped={clamped} />
          <span className="leading-none tabular-nums">{Math.round(clamped)}% de contexto</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="end"
        className={cn(breakdown || account ? 'w-80' : 'w-64')}
      >
        <div className="text-sm">
          {threadId && <AgentAccountSummary account={account} profileName={agentProfileName} />}
          <p className="font-medium">{remaining}% of context remaining until auto-compact.</p>
          <TokenLine usedTokens={usedTokens} maxTokens={maxTokens} />
          <p className="text-muted-foreground mt-1 text-xs">Click to compact now.</p>
          {breakdown && <ContextBreakdownPanel breakdown={breakdown} />}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
