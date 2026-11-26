import type { TFunction } from 'i18next';
import { ExternalLink } from 'lucide-react';
import type { SyntheticEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { GIT_STAT_CHIP_CLASS, GIT_STAT_ICON_CLASS } from '@/components/git/GitStatChip';
import { GitHubExternalLink } from '@/components/GitHubExternalLink';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PR_STATE_ICON, PR_STATE_TEXT_CLASS, type PRState } from '@/lib/git-icons';
import { cn } from '@/lib/utils';
import { openGitHubItem } from '@/stores/github-item-viewer-store';

export interface PRBadgeProps {
  prNumber: number;
  prState?: PRState;
  prUrl?: string;
  /**
   * The project whose repository holds the PR. With it, a click opens funny's
   * PR view and an external link icon beside the chip goes to GitHub; without
   * it (no project: a scratch thread, a PR of another repository) the chip is
   * the GitHub link itself.
   */
  projectId?: string;
  /** "sm" for large displays, "xs" for lists, "compact" for powerline rows, "xxs" for compact headers */
  size?: 'sm' | 'xs' | 'compact' | 'xxs';
  /**
   * "plain" drops the border and fill and takes the git stat chip layout, so the
   * PR lines up with the changes / commits chips in a row. Only the "compact"
   * size changes it: the text and icon of a small powerline, to sit beside one.
   */
  variant?: 'default' | 'inverse' | 'plain';
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
    badge: 'h-4 px-1.5 text-2xs',
    icon: 'h-2.5 w-2.5',
  },
  xxs: {
    badge: 'h-4 px-1 text-2xs',
    icon: 'h-2.5 w-2.5',
  },
} as const;

/** The git stat chip at a small powerline's text size (`PowerlineBar` size "sm"). */
const PLAIN_COMPACT_CLASS = 'flex shrink-0 items-center gap-0.5 text-2xs leading-4';

/** The text color of each state's pill, for the GitHub arrow beside it. */
const STATE_TEXT_CLASS = {
  OPEN: 'text-emerald-700 dark:text-emerald-200',
  MERGED: 'text-violet-700 dark:text-violet-200',
  CLOSED: 'text-rose-700 dark:text-rose-200',
} as const;

/** The GitHub arrow's color: the chip's own text color. */
function externalLinkColorClass(
  variant: NonNullable<PRBadgeProps['variant']>,
  prState: PRState,
): string {
  if (variant === 'plain') return PR_STATE_TEXT_CLASS[prState];
  if (variant === 'inverse') return 'text-background/70';
  return STATE_TEXT_CLASS[prState];
}

const STATE_CLASS = {
  OPEN: 'border-emerald-300/70 bg-emerald-50 text-emerald-700 hover:border-emerald-400 hover:text-emerald-800 dark:border-emerald-400/35 dark:bg-emerald-400/15 dark:text-emerald-200 dark:hover:border-emerald-300/60 dark:hover:text-emerald-100',
  MERGED:
    'border-violet-300/70 bg-violet-50 text-violet-700 hover:border-violet-400 hover:text-violet-800 dark:border-violet-400/35 dark:bg-violet-400/15 dark:text-violet-200 dark:hover:border-violet-300/60 dark:hover:text-violet-100',
  CLOSED:
    'border-rose-300/70 bg-rose-50 text-rose-700 hover:border-rose-400 hover:text-rose-800 dark:border-rose-400/35 dark:bg-rose-400/15 dark:text-rose-200 dark:hover:border-rose-300/60 dark:hover:text-rose-100',
} as const;

function prTooltipLabel(t: TFunction, prState: PRState, prNumber: number): string {
  if (prState === 'OPEN') {
    return t('thread.prOpen', { number: prNumber, defaultValue: `PR #${prNumber}` });
  }
  if (prState === 'MERGED') {
    return t('thread.prMerged', { number: prNumber, defaultValue: `PR #${prNumber} (merged)` });
  }
  return t('thread.prClosed', { number: prNumber, defaultValue: `PR #${prNumber} (closed)` });
}

function prBadgeClassName({
  variant,
  prState,
  size,
  linked,
  className,
}: {
  variant: NonNullable<PRBadgeProps['variant']>;
  prState: PRState;
  size: NonNullable<PRBadgeProps['size']>;
  linked: boolean;
  className?: string;
}): string {
  if (variant === 'plain') {
    return cn(
      size === 'compact' ? PLAIN_COMPACT_CLASS : GIT_STAT_CHIP_CLASS,
      'rounded-sm hover:underline focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none',
      PR_STATE_TEXT_CLASS[prState],
      !linked && 'cursor-default',
      className,
    );
  }
  return cn(
    'inline-flex shrink-0 items-center gap-0.5 rounded-[3px] border leading-none font-semibold focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none',
    SIZE_CLASS[size].badge,
    variant === 'inverse'
      ? 'border-background/20 bg-background/20 text-background/70 hover:text-background'
      : STATE_CLASS[prState],
    !linked && 'cursor-default',
    className,
  );
}

function ProjectPRBadge({
  prNumber,
  prState,
  prUrl,
  projectId,
  size,
  variant,
  className,
  testId,
  tooltipLabel,
  iconClassName,
}: {
  prNumber: number;
  prState: NonNullable<PRBadgeProps['prState']>;
  prUrl?: string;
  projectId: string;
  size: NonNullable<PRBadgeProps['size']>;
  variant: NonNullable<PRBadgeProps['variant']>;
  className?: string;
  testId?: string;
  tooltipLabel: string;
  iconClassName: string;
}) {
  const StateIcon = PR_STATE_ICON[prState];
  const openInFunny = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    openGitHubItem({ kind: 'pr', projectId, number: prNumber, url: prUrl });
  };
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-0.5', className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={openInFunny}
            onKeyDown={(e) => e.stopPropagation()}
            className={prBadgeClassName({ variant, prState, size, linked: true })}
            data-testid={testId}
            aria-label={tooltipLabel}
          >
            <StateIcon
              className={iconClassName}
              aria-hidden="true"
              data-testid={testId ? `${testId}-icon-${prState}` : undefined}
            />
            <span className={cn(variant === 'plain' && 'font-mono')}>#{prNumber}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">{tooltipLabel}</TooltipContent>
      </Tooltip>
      {prUrl && (
        <GitHubExternalLink
          url={prUrl}
          iconClassName={iconClassName}
          className={externalLinkColorClass(variant, prState)}
          data-testid={testId ? `${testId}-external` : undefined}
        />
      )}
    </span>
  );
}

/**
 * Standardized PR number badge/link.
 * State is exposed in the tooltip and soft color so it reads consistently
 * across graph rows, sidebars, dialogs, and PR lists.
 */
export function PRBadge({
  prNumber,
  prState = 'OPEN',
  prUrl,
  projectId,
  size = 'xs',
  variant = 'default',
  showExternalIcon = !!prUrl,
  className,
  ...props
}: PRBadgeProps) {
  const { t } = useTranslation();
  const config = SIZE_CLASS[size];

  const tooltipLabel = prTooltipLabel(t, prState, prNumber);
  const plain = variant === 'plain';
  const iconClassName = plain && size !== 'compact' ? GIT_STAT_ICON_CLASS : config.icon;
  const testId = props['data-testid'];

  if (projectId) {
    return (
      <ProjectPRBadge
        prNumber={prNumber}
        prState={prState}
        prUrl={prUrl}
        projectId={projectId}
        size={size}
        variant={variant}
        className={className}
        testId={testId}
        tooltipLabel={tooltipLabel}
        iconClassName={iconClassName}
      />
    );
  }

  const badgeClassName = prBadgeClassName({ variant, prState, size, linked: !!prUrl, className });
  const StateIcon = PR_STATE_ICON[prState];
  const content = (
    <>
      <StateIcon
        className={iconClassName}
        aria-hidden="true"
        data-testid={testId ? `${testId}-icon-${prState}` : undefined}
      />
      <span className={cn(plain && 'font-mono')}>#{prNumber}</span>
      {showExternalIcon ? <ExternalLink className={iconClassName} aria-hidden="true" /> : null}
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
        <TooltipContent side="top">{tooltipLabel}</TooltipContent>
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
      <TooltipContent side="top">{tooltipLabel}</TooltipContent>
    </Tooltip>
  );
}
