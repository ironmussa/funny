import type { PRCommit } from '@funny/shared';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { AuthorBadge } from '@/components/AuthorBadge';
import { DiffStats } from '@/components/DiffStats';
import { PRBadge } from '@/components/PRBadge';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { getLastCommitAuthor } from './last-commit-author';
import { PRMergeLine } from './PRMergeLine';
import { MergeStatus, PRStateBadge, ReviewDecisionBadge } from './PRStatusBadges';
import { timeAgo } from './time-ago';

type PRCompactState = 'OPEN' | 'MERGED' | 'CLOSED';

interface PRCompactIdentityPR {
  number: number;
  title?: string;
  state?: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  merged_at?: string | null;
  html_url?: string;
  updated_at?: string;
  user?: { login: string; avatar_url?: string } | null;
  head?: { ref: string };
  base?: { ref: string };
  commits?: number;
  last_commit?: PRCommit | null;
  mergeable_state?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  review_decision?: string | null;
}

interface PRCompactIdentityProps {
  pr: PRCompactIdentityPR;
  fallbackState?: PRCompactState;
  fallbackTitle?: string;
  onTitleClick?: () => void;
  titleExtra?: ReactNode;
  contentAfterMerge?: ReactNode;
  showDraftBadge?: boolean;
  showStateBadge?: boolean;
  stats?: {
    additions: number;
    deletions: number;
    changedFiles: number;
  } | null;
  reviewDecision?: string | null;
  mergeableState?: string | null;
  statusExtra?: ReactNode;
  className?: string;
  numberTestId?: string;
  titleTestId?: string;
  mergeLineTestId?: string;
  metaTestId?: string;
  statusTestId?: string;
}

function resolvePRState(pr: PRCompactIdentityPR, fallbackState: PRCompactState): PRCompactState {
  if (pr.merged || pr.merged_at) return 'MERGED';
  if (pr.state === 'closed') return 'CLOSED';
  return fallbackState;
}

export function PRCompactIdentity({
  pr,
  fallbackState = 'OPEN',
  fallbackTitle = 'Pull request',
  onTitleClick,
  titleExtra,
  contentAfterMerge,
  showDraftBadge = false,
  showStateBadge = false,
  stats,
  reviewDecision,
  mergeableState,
  statusExtra,
  className,
  numberTestId,
  titleTestId,
  mergeLineTestId,
  metaTestId,
  statusTestId,
}: PRCompactIdentityProps) {
  const { t } = useTranslation();
  const title = pr.title ?? fallbackTitle;
  const lastCommitAuthor = getLastCommitAuthor(pr);
  const resolvedState = resolvePRState(pr, fallbackState);
  const shouldShowStateBadge = showStateBadge && !!pr.draft;
  const mergeLinePr =
    pr.head && pr.base
      ? {
          number: pr.number,
          html_url: pr.html_url,
          user: pr.user ?? null,
          head: { ref: pr.head.ref },
          base: { ref: pr.base.ref },
          commits: pr.commits,
        }
      : null;
  const hasMeta = !!pr.updated_at || !!lastCommitAuthor || (showDraftBadge && !!pr.draft);
  const effectiveStats =
    stats ??
    (typeof pr.additions === 'number' &&
    typeof pr.deletions === 'number' &&
    typeof pr.changed_files === 'number'
      ? {
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changed_files,
        }
      : null);
  const effectiveReviewDecision = reviewDecision ?? pr.review_decision ?? null;
  const effectiveMergeableState = mergeableState ?? pr.mergeable_state ?? null;
  const isMerged = resolvedState === 'MERGED';
  const showMergeStatus =
    !isMerged &&
    (effectiveMergeableState === 'mergeable' || effectiveMergeableState === 'conflicting');

  return (
    <div className={cn('flex min-w-0 flex-1 flex-col gap-1', className)}>
      <div className="flex items-start gap-2">
        <PRBadge
          prNumber={pr.number}
          prState={resolvedState}
          prUrl={pr.html_url}
          size="xxs"
          className="mt-0.5"
          data-testid={numberTestId}
        />
        <div className="min-w-0 flex-1 text-[11px] leading-5 break-words">
          {onTitleClick ? (
            <button
              type="button"
              onClick={onTitleClick}
              className="focus-visible:ring-ring text-foreground min-w-0 text-left font-medium hover:underline focus-visible:ring-1 focus-visible:outline-none"
              data-testid={titleTestId}
            >
              {title}
            </button>
          ) : (
            <span
              className={cn('font-medium', pr.title ? 'text-foreground' : 'text-muted-foreground')}
              data-testid={titleTestId}
            >
              {title}
            </span>
          )}
        </div>
        {titleExtra}
      </div>

      {mergeLinePr ? (
        <PRMergeLine pr={mergeLinePr} showDiffLink={false} data-testid={mergeLineTestId} />
      ) : null}

      {contentAfterMerge}

      {hasMeta ? (
        <div
          className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-[10px]"
          data-testid={metaTestId}
        >
          {pr.updated_at ? (
            <span>
              {t('review.pullRequests.updated', 'Updated')} {timeAgo(pr.updated_at)}
            </span>
          ) : null}
          {lastCommitAuthor ? (
            <>
              {pr.updated_at ? <span>&middot;</span> : null}
              <span>{t('review.pullRequests.lastCommitBy', 'Last commit by')}</span>
              <AuthorBadge
                name={lastCommitAuthor.name}
                avatarUrl={lastCommitAuthor.avatarUrl}
                size="xs"
              />
            </>
          ) : null}
          {showDraftBadge && pr.draft ? (
            <>
              {pr.updated_at || lastCommitAuthor ? <span>&middot;</span> : null}
              <Badge variant="outline" className="h-3.5 px-1 py-0 text-[9px] leading-none">
                {t('review.pullRequests.draft', 'Draft')}
              </Badge>
            </>
          ) : null}
        </div>
      ) : null}

      {shouldShowStateBadge ||
      effectiveStats ||
      effectiveReviewDecision ||
      showMergeStatus ||
      statusExtra ? (
        <div className="flex flex-wrap items-center gap-2" data-testid={statusTestId}>
          {shouldShowStateBadge ? (
            <PRStateBadge
              state={resolvedState === 'CLOSED' ? 'closed' : 'open'}
              draft={!!pr.draft}
              merged={resolvedState === 'MERGED'}
            />
          ) : null}
          {effectiveStats ? (
            <DiffStats
              linesAdded={effectiveStats.additions}
              linesDeleted={effectiveStats.deletions}
              dirtyFileCount={effectiveStats.changedFiles}
              variant="pr"
              size="xxs"
              tooltips
            />
          ) : null}
          {effectiveReviewDecision ? (
            <ReviewDecisionBadge decision={effectiveReviewDecision} />
          ) : null}
          {showMergeStatus ? (
            <MergeStatus mergeable={effectiveMergeableState} merged={isMerged} />
          ) : null}
          {statusExtra}
        </div>
      ) : null}
    </div>
  );
}
