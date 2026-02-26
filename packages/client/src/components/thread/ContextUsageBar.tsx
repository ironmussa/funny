/**
 * ContextUsageBar — Thin progress bar showing context window usage.
 * Displayed below the thread header while the agent is running.
 */

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const DEFAULT_CONTEXT_WINDOW = 200_000;

interface Props {
  cumulativeInputTokens: number;
}

export function ContextUsageBar({ cumulativeInputTokens }: Props) {
  const maxTokens = DEFAULT_CONTEXT_WINDOW;
  const pct = Math.min(100, (cumulativeInputTokens / maxTokens) * 100);
  const tokenK = Math.round(cumulativeInputTokens / 1000);
  const maxK = Math.round(maxTokens / 1000);

  if (cumulativeInputTokens === 0) return null;

  const color =
    pct > 80 ? 'bg-red-500' : pct > 60 ? 'bg-amber-500' : 'bg-primary';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="mx-4 mt-1 mb-0 h-1 rounded-full bg-muted cursor-default">
          <div
            className={cn('h-full rounded-full transition-all duration-500', color)}
            style={{ width: `${pct}%` }}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        Context: {tokenK}K / {maxK}K tokens ({pct.toFixed(0)}%)
      </TooltipContent>
    </Tooltip>
  );
}
