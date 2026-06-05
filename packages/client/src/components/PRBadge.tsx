import { GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface PRBadgeProps {
  prNumber: number;
  prState: 'OPEN' | 'MERGED' | 'CLOSED';
  prUrl?: string;
  /** "sm" for large displays, "xs" for sidebar thread items, "xxs" for compact headers */
  size?: 'sm' | 'xs' | 'xxs';
  className?: string;
  'data-testid'?: string;
}

const CONFIG = {
  MERGED: {
    icon: GitMerge,
    color: 'text-purple-500!',
    label: 'merged',
  },
  CLOSED: {
    icon: GitPullRequestClosed,
    color: 'text-red-500!',
    label: 'closed',
  },
  OPEN: {
    icon: GitPullRequest,
    color: 'text-green-500!',
    label: 'open',
  },
} as const;

/**
 * Standardized PR number badge with state-colored icon.
 * Renders identically in sidebar thread items and review pane header.
 */
export function PRBadge({
  prNumber,
  prState,
  prUrl,
  size = 'xs',
  className,
  ...props
}: PRBadgeProps) {
  const { t } = useTranslation();
  const { icon: Icon, color } = CONFIG[prState] ?? CONFIG.OPEN;

  const textSize = size === 'xxs' ? 'text-[10px]' : size === 'xs' ? 'text-xs' : 'text-sm';
  const iconSize = size === 'sm' ? 'h-3.5 w-3.5' : size === 'xs' ? 'icon-xs' : 'h-2.5 w-2.5';

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

  if (prUrl) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              window.open(prUrl, '_blank', 'noopener,noreferrer');
            }}
            className={cn(
              'flex shrink-0 items-center gap-0.5 font-mono hover:underline',
              textSize,
              color,
              className,
            )}
            data-testid={props['data-testid']}
          >
            <Icon className={iconSize} />
            <span>#{prNumber}</span>
          </button>
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
        <span
          className={cn('flex shrink-0 items-center gap-0.5 font-mono', textSize, color, className)}
          data-testid={props['data-testid']}
        >
          <Icon className={iconSize} />
          <span>#{prNumber}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {tooltipLabel}
      </TooltipContent>
    </Tooltip>
  );
}
