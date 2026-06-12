import type { CICheck } from '@funny/shared';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Loader2,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { DiffStats } from '@/components/DiffStats';
import { PRBadge } from '@/components/PRBadge';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePRDetail, usePRDetailStore } from '@/stores/pr-detail-store';

const POLL_INTERVAL = 30_000;
const MAX_VISIBLE_CHECKS = 6;

interface PRSummaryCardProps {
  projectId: string;
  prNumber: number;
  prUrl: string;
  prState: 'OPEN' | 'MERGED' | 'CLOSED';
  visible: boolean;
}

export function CheckIcon({ check }: { check: CICheck }) {
  if (check.status !== 'completed') {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-yellow-500" />;
  }
  switch (check.conclusion) {
    case 'success':
    case 'neutral':
    case 'skipped':
      return <CheckCircle2 className="size-3.5 shrink-0 text-green-500" />;
    case 'failure':
    case 'timed_out':
    case 'action_required':
      return <XCircle className="size-3.5 shrink-0 text-red-500" />;
    case 'cancelled':
      return <Circle className="text-muted-foreground size-3.5 shrink-0" />;
    default:
      return <Clock className="size-3.5 shrink-0 text-yellow-500" />;
  }
}

export function PRStateBadge({
  state,
  draft,
  merged,
}: {
  state: string;
  draft: boolean;
  merged: boolean;
}) {
  if (merged) {
    return (
      <Badge
        variant="outline"
        size="xxs"
        className="gap-1 border-purple-500/30 bg-purple-500/15 text-purple-400"
      >
        <GitMerge className="size-2.5" />
        Merged
      </Badge>
    );
  }
  if (state === 'closed') {
    return (
      <Badge
        variant="outline"
        size="xxs"
        className="gap-1 border-red-500/30 bg-red-500/15 text-red-400"
      >
        <GitPullRequestClosed className="size-2.5" />
        Closed
      </Badge>
    );
  }
  if (draft) {
    return (
      <Badge
        variant="outline"
        size="xxs"
        className="border-muted-foreground/30 bg-muted text-muted-foreground gap-1"
      >
        <GitPullRequest className="size-2.5" />
        Draft
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      size="xxs"
      className="gap-1 border-green-500/30 bg-green-500/15 text-green-400"
    >
      <GitPullRequest className="size-2.5" />
      Open
    </Badge>
  );
}

export function ReviewDecisionBadge({ decision }: { decision: string | null }) {
  if (!decision) return null;
  switch (decision) {
    case 'APPROVED':
      return (
        <span className="flex items-center gap-1 text-[11px] text-green-400">
          <CheckCircle2 className="size-3.5" /> Approved
        </span>
      );
    case 'CHANGES_REQUESTED':
      return (
        <span className="flex items-center gap-1 text-[11px] text-red-400">
          <AlertCircle className="size-3.5" /> Changes requested
        </span>
      );
    case 'REVIEW_REQUIRED':
      return (
        <span className="flex items-center gap-1 text-[11px] text-yellow-400">
          <Clock className="size-3.5" /> Review required
        </span>
      );
    default:
      return null;
  }
}

export function MergeStatus({ mergeable, merged }: { mergeable: string; merged: boolean }) {
  if (merged) return null;
  switch (mergeable) {
    case 'mergeable':
      return (
        <span className="flex items-center gap-1 text-[11px] text-green-400">
          <GitMerge className="size-3.5" /> Ready to merge
        </span>
      );
    case 'conflicting':
      return (
        <span className="flex items-center gap-1 text-[11px] text-red-400">
          <AlertCircle className="size-3.5" /> Merge conflicts
        </span>
      );
    default:
      return null;
  }
}

export function PRSummaryCard({
  projectId,
  prNumber,
  prUrl,
  prState,
  visible,
}: PRSummaryCardProps) {
  const { detail, loadingDetail, rateLimited } = usePRDetail(projectId, prNumber);
  const [checksOpen, setChecksOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch on mount + poll while visible
  useEffect(() => {
    if (!visible || !projectId || !prNumber) return;

    const store = usePRDetailStore.getState();
    store.fetchPRDetail(projectId, prNumber);
    store.fetchPRThreads(projectId, prNumber);

    pollRef.current = setInterval(() => {
      const s = usePRDetailStore.getState();
      if (!s.rateLimited) {
        s.fetchPRDetail(projectId, prNumber);
        s.fetchPRThreads(projectId, prNumber);
      }
    }, POLL_INTERVAL);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [visible, projectId, prNumber]);

  // Sort checks: failures first, then pending, then success
  const sortedChecks = detail?.checks
    ? detail.checks.toSorted((a, b) => {
        const priority = (c: CICheck) => {
          if (c.status !== 'completed') return 1;
          if (
            c.conclusion === 'failure' ||
            c.conclusion === 'timed_out' ||
            c.conclusion === 'action_required'
          )
            return 0;
          if (
            c.conclusion === 'success' ||
            c.conclusion === 'neutral' ||
            c.conclusion === 'skipped'
          )
            return 2;
          return 1;
        };
        return priority(a) - priority(b);
      })
    : [];

  const visibleChecks = checksOpen ? sortedChecks : sortedChecks.slice(0, MAX_VISIBLE_CHECKS);
  const hasMoreChecks = sortedChecks.length > MAX_VISIBLE_CHECKS;
  const totalChecks = sortedChecks.length;

  // Whether <MergeStatus> renders anything (only for open, mergeable/conflicting PRs)
  const mergeStatusVisible =
    !!detail &&
    !detail.merged &&
    (detail.mergeable_state === 'mergeable' || detail.mergeable_state === 'conflicting');

  return (
    <div
      className="border-sidebar-border bg-muted/30 border-b px-3 py-2 text-xs"
      data-testid="pr-summary-card"
    >
      {/* Line 1: PR title → number → actions */}
      <div className="flex items-start gap-2">
        {/* Full title shown (no truncation); number flows inline after the last word */}
        <div className="min-w-0 flex-1 text-[11px] break-words">
          {detail ? (
            <span className="text-foreground font-medium" data-testid="pr-summary-title">
              {detail.title}
            </span>
          ) : (
            <span className="text-muted-foreground">PR #{prNumber}</span>
          )}{' '}
          <PRBadge
            prNumber={prNumber}
            prState={detail?.merged ? 'MERGED' : detail?.state === 'closed' ? 'CLOSED' : prState}
            prUrl={detail?.html_url ?? prUrl}
            size="xxs"
            className="inline-flex align-middle"
            data-testid="pr-summary-number"
          />
        </div>
        {rateLimited && (
          <Tooltip>
            <TooltipTrigger>
              <span className="shrink-0 text-[11px] text-yellow-500">Rate limited</span>
            </TooltipTrigger>
            <TooltipContent>GitHub API rate limit reached. Polling paused.</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Line 2: state badge → diff stats → review decision */}
      <div className="mt-1.5 flex items-center gap-2">
        {detail ? (
          <PRStateBadge state={detail.state} draft={detail.draft} merged={detail.merged} />
        ) : (
          <PRStateBadge
            state={prState === 'CLOSED' ? 'closed' : 'open'}
            draft={false}
            merged={prState === 'MERGED'}
          />
        )}
        {detail && (
          <DiffStats
            linesAdded={detail.additions}
            linesDeleted={detail.deletions}
            dirtyFileCount={detail.changed_files}
            variant="pr"
            size="xxs"
            tooltips
          />
        )}
        {detail && <ReviewDecisionBadge decision={detail.review_decision} />}
      </div>

      {/* Merge summary: "<author> wants to merge N commits into <base> from <head>" */}
      {detail && detail.base.ref && detail.head.ref && (
        <p
          className="text-muted-foreground mt-1.5 text-[11px] break-words"
          data-testid="pr-summary-merge-info"
        >
          {detail.user?.login && (
            <span className="text-foreground font-medium">{detail.user.login}</span>
          )}{' '}
          wants to merge{' '}
          <span className="text-foreground font-medium">
            {detail.commits} {detail.commits === 1 ? 'commit' : 'commits'}
          </span>{' '}
          into <span className="text-foreground font-mono">{detail.base.ref}</span> from{' '}
          <span className="text-foreground font-mono">{detail.head.ref}</span>
        </p>
      )}

      {/* Line 3: CI checks → ready to merge */}
      {detail && (totalChecks > 0 || mergeStatusVisible) && (
        <Collapsible open={checksOpen} onOpenChange={setChecksOpen} className="mt-1.5">
          <div className="flex items-center gap-3">
            {totalChecks > 0 && (
              <CollapsibleTrigger
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px]"
                data-testid="pr-summary-checks-toggle"
              >
                {checksOpen ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
                <span>
                  CI Checks ({detail.checks_passed}/{totalChecks} passed)
                  {detail.checks_failed > 0 && (
                    <span className="ml-1 text-red-400">{detail.checks_failed} failed</span>
                  )}
                  {detail.checks_pending > 0 && (
                    <span className="ml-1 text-yellow-400">{detail.checks_pending} pending</span>
                  )}
                </span>
              </CollapsibleTrigger>
            )}
            <MergeStatus mergeable={detail.mergeable_state} merged={detail.merged} />
          </div>
          {totalChecks > 0 && (
            <CollapsibleContent>
              <div className="mt-1 space-y-0.5 pl-4" data-testid="pr-summary-checks-list">
                {visibleChecks.map((check) => (
                  <div key={check.id} className="flex items-center gap-1.5 text-[11px]">
                    <CheckIcon check={check} />
                    <span className="truncate">{check.name}</span>
                    {check.app_name && (
                      <span className="text-muted-foreground shrink-0">({check.app_name})</span>
                    )}
                    {check.html_url && (
                      <a
                        href={check.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground ml-auto shrink-0"
                        data-testid={`pr-check-link-${check.id}`}
                      >
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </div>
                ))}
                {hasMoreChecks && !checksOpen && (
                  <button
                    className="text-primary text-[11px] hover:underline"
                    onClick={() => setChecksOpen(true)}
                    data-testid="pr-summary-show-more-checks"
                  >
                    +{sortedChecks.length - MAX_VISIBLE_CHECKS} more
                  </button>
                )}
              </div>
            </CollapsibleContent>
          )}
        </Collapsible>
      )}

      {/* Loading skeleton when no detail yet */}
      {!detail && loadingDetail && (
        <div className="text-muted-foreground mt-1 flex items-center gap-2">
          <Loader2 className="size-3.5 animate-spin" />
          <span className="text-[11px]">Loading PR details…</span>
        </div>
      )}
    </div>
  );
}
