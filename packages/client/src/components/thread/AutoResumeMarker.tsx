import { RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

function formatClock(timestamp?: string): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Where the runner resumed a turn its own restart interrupted. Technically it
 * is a user message (the prompt the runner sent), but the user did not write
 * it, so it shows as a quiet divider instead of a user card.
 */
export function AutoResumeMarker({
  timestamp,
  'data-testid': testId,
}: {
  timestamp?: string;
  'data-testid'?: string;
}) {
  const { t } = useTranslation();
  const clock = formatClock(timestamp);
  return (
    <div
      role="separator"
      data-testid={testId}
      className="text-muted-foreground/70 flex items-center gap-3 py-1 text-xs"
    >
      <span className="bg-border h-px flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex shrink-0 cursor-default items-center gap-1.5">
            <RotateCw className="size-3" aria-hidden />
            <span>{t('thread.autoResumed')}</span>
            {clock && <span className="tabular-nums">· {clock}</span>}
          </span>
        </TooltipTrigger>
        <TooltipContent>{t('thread.autoResumedTooltip')}</TooltipContent>
      </Tooltip>
      <span className="bg-border h-px flex-1" />
    </div>
  );
}
