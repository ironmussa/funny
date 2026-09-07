import { findTextSearchMatches } from '@funny/shared/lib/text-search';

import { cn } from '@/lib/utils';

import { HighlightText } from './highlight-text';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

/** Truncate the basename while reserving space for the file extension. */
export function FileName({
  name,
  query = '',
  className,
  preserveExtension = true,
}: {
  name: string;
  query?: string;
  className?: string;
  preserveExtension?: boolean;
}) {
  const lastDot = name.lastIndexOf('.');
  const split =
    preserveExtension && lastDot > 0 && lastDot < name.length - 1 ? lastDot : name.length;
  const matches = query.trim() ? findTextSearchMatches(name, query) : [];
  const stemRanges = matches
    .filter(({ start }) => start < split)
    .map(({ start, end }) => ({ start, end: Math.min(end, split) }));
  const extensionRanges = matches
    .filter(({ end }) => end > split)
    .map(({ start, end }) => ({ start: Math.max(start, split) - split, end: end - split }));

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('flex min-w-0 flex-1 items-baseline', className)}>
          <HighlightText
            text={name.slice(0, split)}
            ranges={stemRanges}
            className="min-w-0 truncate"
          />
          {split < name.length && (
            <HighlightText
              text={name.slice(split)}
              ranges={extensionRanges}
              className="shrink-0 whitespace-nowrap"
            />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm break-all">
        {name}
      </TooltipContent>
    </Tooltip>
  );
}
