import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Characters of a commit hash shown in lists (git's own default abbreviation). */
const SHORT_HASH_LENGTH = 7;

/**
 * The one way a commit hash is shown in a list: the first seven characters in
 * monospace, the full hash in a tooltip.
 */
export function CommitHash({
  hash,
  className,
  'data-testid': testId,
}: {
  hash: string;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('shrink-0 font-mono', className)} data-testid={testId}>
          {hash.slice(0, SHORT_HASH_LENGTH)}
        </span>
      </TooltipTrigger>
      <TooltipContent variant="mono">{hash}</TooltipContent>
    </Tooltip>
  );
}
