import type { GitHubPR } from '@funny/shared';
import { ExternalLink, FileCode } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { BranchBadge } from '@/components/BranchBadge';
import { cn } from '@/lib/utils';

interface PRMergeLineProps {
  pr: GitHubPR;
  showDiffLink?: boolean;
  className?: string;
  'data-testid'?: string;
}

function diffUrl(prUrl: string): string {
  return `${prUrl.replace(/\/$/, '')}/files`;
}

export function PRMergeLine({ pr, showDiffLink = true, className, ...props }: PRMergeLineProps) {
  const { t } = useTranslation();
  const hasMergeInfo = !!pr.base.ref && !!pr.head.ref && typeof pr.commits === 'number';

  if (!hasMergeInfo && (!showDiffLink || !pr.html_url)) return null;

  return (
    <div
      className={cn(
        'text-muted-foreground flex flex-wrap items-center gap-1.5 text-[10px] leading-5',
        className,
      )}
      data-testid={props['data-testid']}
    >
      {hasMergeInfo ? (
        <>
          <span>
            <span className="text-foreground font-medium">
              {pr.user?.login ?? t('review.pullRequests.unknownAuthor', 'unknown')}
            </span>{' '}
            {t('review.pullRequests.wantsToMerge', 'wants to merge')}{' '}
            <span className="text-foreground font-medium">
              {pr.commits} {pr.commits === 1 ? 'commit' : 'commits'}
            </span>{' '}
            {t('review.pullRequests.into', 'into')}
          </span>
          <BranchBadge branch={pr.base.ref} size="xs" />
          <span>{t('review.pullRequests.from', 'from')}</span>
          <BranchBadge branch={pr.head.ref} size="xs" />
        </>
      ) : null}
      {showDiffLink && pr.html_url ? (
        <>
          {hasMergeInfo ? <span>&middot;</span> : null}
          <a
            href={diffUrl(pr.html_url)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            className="hover:text-foreground focus-visible:ring-ring inline-flex items-center gap-1 rounded-[3px] underline-offset-2 hover:underline focus-visible:ring-1 focus-visible:outline-none"
            data-testid={`pr-diff-link-${pr.number}`}
          >
            <FileCode className="icon-xs" aria-hidden="true" />
            <span>{t('review.pullRequests.diff', 'Diff')}</span>
            <ExternalLink className="size-2.5" aria-hidden="true" />
          </a>
        </>
      ) : null}
    </div>
  );
}
