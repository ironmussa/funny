import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';

interface Props {
  pct: number;
  usedTokens?: number;
  maxTokens?: number;
  onCompact?: () => void;
  disabled?: boolean;
}

const SIZE = 18;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * RADIUS;

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
};

export function ContextUsageRing({ pct, usedTokens, maxTokens, onCompact, disabled }: Props) {
  const clamped = Math.max(0, Math.min(100, pct));
  const remaining = Math.max(0, Math.round(100 - clamped));
  const dash = (clamped / 100) * CIRC;
  const showTokens =
    typeof usedTokens === 'number' && typeof maxTokens === 'number' && maxTokens > 0;
  const remainingTokens = showTokens ? Math.max(0, maxTokens - usedTokens) : 0;

  const color =
    clamped > 80 ? 'stroke-red-500' : clamped > 60 ? 'stroke-amber-500' : 'stroke-muted-foreground';

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
            'mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted',
            disabled && 'cursor-not-allowed opacity-50',
          )}
        >
          <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="-rotate-90">
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
              className={cn('transition-[stroke-dasharray] duration-500', color)}
            />
          </svg>
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="end" className="w-64 text-sm">
        <p className="font-medium">{remaining}% of context remaining until auto-compact.</p>
        {showTokens && (
          <p className="mt-1 text-xs text-muted-foreground">
            {formatTokens(usedTokens)} / {formatTokens(maxTokens)} tokens used ·{' '}
            {formatTokens(remainingTokens)} left
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">Click to compact now.</p>
      </HoverCardContent>
    </HoverCard>
  );
}
