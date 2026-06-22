import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface PRBadgeProps {
  prNumber: number;
  prState?: 'OPEN' | 'MERGED' | 'CLOSED';
  prUrl?: string;
  /** "sm" for large displays, "xs" for sidebar thread items, "xxs" for compact headers */
  size?: 'sm' | 'xs' | 'xxs';
  showExternalIcon?: boolean;
  className?: string;
  'data-testid'?: string;
}

const SIZE_CLASS = {
  sm: {
    badge: 'h-6 px-2 text-sm',
    icon: 'h-3.5 w-3.5',
  },
  xs: {
    badge: 'h-5 px-1.5 text-xs',
    icon: 'h-3 w-3',
  },
  xxs: {
    badge: 'h-4 px-1 text-[10px]',
    icon: 'h-2.5 w-2.5',
  },
} as const;

/**
 * Standardized PR number badge/link.
 * State is exposed in the tooltip; color stays neutral so the badge reads
 * consistently across graph rows, sidebars, dialogs, and PR lists.
 */
export function PRBadge({
  prNumber,
  prState = 'OPEN',
  prUrl,
  size = 'xs',
  showExternalIcon = !!prUrl,
  className,
  ...props
}: PRBadgeProps) {
  const { t } = useTranslation();
  const config = SIZE_CLASS[size];

  const tooltipLabel =
    prState === 'OPEN'
      ? t('thread.prOpen', { number: prNumber, defaultValue: `PR #${prNumber}` })
      : prState === 'MERGED'
        ? t('thread.prMerged', {
            number: prNumber,
            defaultValue: `PR #${prNumber} (merged)`,
          })
        : t('thread.prClosed', {
            number: prNumber,
            defaultValue: `PR #${prNumber} (closed)`,
          });
  const badgeClassName = cn(
    'border-border/70 bg-background/90 text-foreground inline-flex shrink-0 items-center gap-0.5 rounded-[3px] border leading-none font-semibold hover:border-primary/60 hover:text-primary focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none',
    config.badge,
    !prUrl && 'hover:border-border/70 hover:text-foreground',
    className,
  );
  const content = (
    <>
      <span>#{prNumber}</span>
      {showExternalIcon ? <ExternalLink className={config.icon} aria-hidden="true" /> : null}
    </>
  );

  if (prUrl) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              e.stopPropagation();
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className={badgeClassName}
            data-testid={props['data-testid']}
            aria-label={tooltipLabel}
          >
            {content}
          </a>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {tooltipLabel}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={badgeClassName} data-testid={props['data-testid']}>
          {content}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {tooltipLabel}
      </TooltipContent>
    </Tooltip>
  );
}
