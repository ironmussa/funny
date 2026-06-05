import type { CICheck } from '@funny/shared';
import { CircleDashed, ExternalLink, GitPullRequest, RefreshCw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { CheckIcon, MergeStatus, ReviewDecisionBadge } from '@/components/PRSummaryCard';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { usePRDetail, usePRDetailStore } from '@/stores/pr-detail-store';

const POLL_INTERVAL = 30_000;

interface CITabProps {
  projectId: string;
  prNumber?: number;
  prUrl?: string;
  visible: boolean;
}

// Failures first, then pending, then successes — so red is always at the top.
function sortChecks(checks: CICheck[]): CICheck[] {
  const priority = (c: CICheck) => {
    if (c.status !== 'completed') return 1;
    if (
      c.conclusion === 'failure' ||
      c.conclusion === 'timed_out' ||
      c.conclusion === 'action_required'
    )
      return 0;
    if (c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped')
      return 2;
    return 1;
  };
  return checks.toSorted((a, b) => priority(a) - priority(b));
}

export function CITab({ projectId, prNumber, prUrl, visible }: CITabProps) {
  const { t } = useTranslation();
  const { detail, loadingDetail, rateLimited } = usePRDetail(projectId || undefined, prNumber);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch on mount + poll while visible (mirrors PRSummaryCard cadence).
  useEffect(() => {
    if (!visible || !projectId || !prNumber) return;

    usePRDetailStore.getState().fetchPRDetail(projectId, prNumber);
    pollRef.current = setInterval(() => {
      const s = usePRDetailStore.getState();
      if (!s.rateLimited) s.fetchPRDetail(projectId, prNumber);
    }, POLL_INTERVAL);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [visible, projectId, prNumber]);

  const handleRefresh = () => {
    if (projectId && prNumber) usePRDetailStore.getState().fetchPRDetail(projectId, prNumber, true);
  };

  if (!projectId) {
    return (
      <EmptyState
        icon={GitPullRequest}
        title={t('review.ci.noProject', 'Select a project to view CI status')}
      />
    );
  }

  if (!prNumber) {
    return (
      <EmptyState
        icon={CircleDashed}
        title={t('review.ci.noPR', 'No pull request for this branch yet')}
        description={t('review.ci.noPRHint', 'CI status appears once a pull request is open.')}
      />
    );
  }

  if (!detail && loadingDetail) {
    return (
      <LoadingState testId="ci-loading" label={t('review.ci.loading', 'Loading CI status…')} />
    );
  }

  const checks = detail ? sortChecks(detail.checks) : [];
  const total = checks.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ci-tab">
      {/* Toolbar / summary */}
      <div className="flex items-center gap-3 border-b border-sidebar-border px-3 py-1.5 text-xs">
        {detail && total > 0 && (
          <span className="font-medium" data-testid="ci-summary-counts">
            {t('review.ci.passedCount', '{{passed}}/{{total}} passed', {
              passed: detail.checks_passed,
              total,
            })}
            {detail.checks_failed > 0 && (
              <span className="ml-1.5 text-red-400">
                {t('review.ci.failedCount', '{{count}} failed', { count: detail.checks_failed })}
              </span>
            )}
            {detail.checks_pending > 0 && (
              <span className="ml-1.5 text-yellow-400">
                {t('review.ci.pendingCount', '{{count}} pending', {
                  count: detail.checks_pending,
                })}
              </span>
            )}
          </span>
        )}
        {detail && <ReviewDecisionBadge decision={detail.review_decision} />}
        {detail && <MergeStatus mergeable={detail.mergeable_state} merged={detail.merged} />}

        <div className="min-w-0 flex-1" />

        {rateLimited && (
          <Tooltip>
            <TooltipTrigger>
              <span className="text-[10px] text-yellow-500">
                {t('review.ci.rateLimited', 'Rate limited')}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t('review.ci.rateLimitedHint', 'GitHub API rate limit reached. Polling paused.')}
            </TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleRefresh}
              disabled={loadingDetail}
              className="shrink-0 text-muted-foreground"
              data-testid="ci-refresh"
            >
              <RefreshCw className={cn('icon-base', loadingDetail && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('common.refresh', 'Refresh')}</TooltipContent>
        </Tooltip>

        {prUrl && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                asChild
                className="shrink-0 text-muted-foreground"
                data-testid="ci-open-github"
              >
                <a href={prUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="icon-base" />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('review.ci.openOnGithub', 'Open PR on GitHub')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Checks list */}
      {total === 0 ? (
        <EmptyState
          icon={CircleDashed}
          title={t('review.ci.noChecks', 'No CI checks reported for this PR')}
        />
      ) : (
        <ScrollArea className="flex min-h-0 flex-1 flex-col">
          <div
            className="flex flex-col divide-y divide-sidebar-border"
            data-testid="ci-checks-list"
          >
            {checks.map((check) => (
              <div
                key={check.id}
                className="flex items-center gap-2 px-3 py-1.5 text-xs"
                data-testid={`ci-check-${check.id}`}
              >
                <CheckIcon check={check} />
                <span className="truncate font-medium">{check.name}</span>
                {check.app_name && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    ({check.app_name})
                  </span>
                )}
                {check.html_url && (
                  <a
                    href={check.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                    data-testid={`ci-check-link-${check.id}`}
                  >
                    <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
