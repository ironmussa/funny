import { ExternalLink, GitPullRequest } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface PRBadgeProps {
  prNumber: number;
  prState?: 'OPEN' | 'MERGED' | 'CLOSED';
  prUrl?: string;
  /** "sm" for large displays, "xs" for lists, "compact" for powerline rows, "xxs" for compact headers */
  size?: 'sm' | 'xs' | 'compact' | 'xxs';
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
  compact: {
    badge: 'h-[15px] px-1 text-[10px]',
    icon: 'h-2.5 w-2.5',
  },
  xxs: {
    badge: 'h-4 px-1 text-[10px]',
    icon: 'h-2.5 w-2.5',
  },
} as const;

const STATE_CLASS = {
  OPEN: 'border-emerald-300/70 bg-emerald-50 text-emerald-700 hover:border-emerald-400 hover:text-emerald-800 dark:border-emerald-400/35 dark:bg-emerald-400/15 dark:text-emerald-200 dark:hover:border-emerald-300/60 dark:hover:text-emerald-100',
  MERGED:
    'border-violet-300/70 bg-violet-50 text-violet-700 hover:border-violet-400 hover:text-violet-800 dark:border-violet-400/35 dark:bg-violet-400/15 dark:text-violet-200 dark:hover:border-violet-300/60 dark:hover:text-violet-100',
  CLOSED:
    'border-rose-300/70 bg-rose-50 text-rose-700 hover:border-rose-400 hover:text-rose-800 dark:border-rose-400/35 dark:bg-rose-400/15 dark:text-rose-200 dark:hover:border-rose-300/60 dark:hover:text-rose-100',
} as const;

/**
 * Standardized PR number badge/link.
 * State is exposed in the tooltip and soft color so it reads consistently
 * across graph rows, sidebars, dialogs, and PR lists.
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
    'inline-flex shrink-0 items-center gap-0.5 rounded-[3px] border leading-none font-semibold focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none',
    config.badge,
    STATE_CLASS[prState],
    !prUrl && 'cursor-default',
    className,
  );
  const content = (
    <>
      <GitPullRequest className={config.icon} aria-hidden="true" />
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
