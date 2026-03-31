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
  RefreshCw,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
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

function CheckIcon({ check }: { check: CICheck }) {
  if (check.status !== 'completed') {
    return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-yellow-500" />;
  }
  switch (check.conclusion) {
    case 'success':
    case 'neutral':
    case 'skipped':
      return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />;
    case 'failure':
    case 'timed_out':
    case 'action_required':
      return <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />;
    case 'cancelled':
      return <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
    default:
      return <Clock className="h-3.5 w-3.5 shrink-0 text-yellow-500" />;
  }
}

function PRStateBadge({
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
      <Badge size="xxs" className="gap-1 border-purple-500/30 bg-purple-500/15 text-purple-400">
        <GitMerge className="h-2.5 w-2.5" />
        Merged
      </Badge>
    );
  }
  if (state === 'closed') {
    return (
      <Badge size="xxs" className="gap-1 border-red-500/30 bg-red-500/15 text-red-400">
        <GitPullRequestClosed className="h-2.5 w-2.5" />
        Closed
      </Badge>
    );
  }
  if (draft) {
    return (
      <Badge size="xxs" className="gap-1 border-muted-foreground/30 bg-muted text-muted-foreground">
        <GitPullRequest className="h-2.5 w-2.5" />
        Draft
      </Badge>
    );
  }
  return (
    <Badge size="xxs" className="gap-1 border-green-500/30 bg-green-500/15 text-green-400">
      <GitPullRequest className="h-2.5 w-2.5" />
      Open
    </Badge>
  );
}

function ReviewDecisionBadge({ decision }: { decision: string | null }) {
  if (!decision) return null;
  switch (decision) {
    case 'APPROVED':
      return (
        <span className="flex items-center gap-1 text-[10px] text-green-400">
          <CheckCircle2 className="h-3 w-3" /> Approved
        </span>
      );
    case 'CHANGES_REQUESTED':
      return (
        <span className="flex items-center gap-1 text-[10px] text-red-400">
          <AlertCircle className="h-3 w-3" /> Changes requested
        </span>
      );
    case 'REVIEW_REQUIRED':
      return (
        <span className="flex items-center gap-1 text-[10px] text-yellow-400">
          <Clock className="h-3 w-3" /> Review required
        </span>
      );
    default:
      return null;
  }
}

function MergeStatus({ mergeable, merged }: { mergeable: string; merged: boolean }) {
  if (merged) return null;
  switch (mergeable) {
    case 'mergeable':
      return (
        <span className="flex items-center gap-1 text-[10px] text-green-400">
          <GitMerge className="h-3 w-3" /> Ready to merge
        </span>
      );
    case 'conflicting':
      return (
        <span className="flex items-center gap-1 text-[10px] text-red-400">
          <AlertCircle className="h-3 w-3" /> Merge conflicts
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

  const handleRefresh = () => {
    usePRDetailStore.getState().fetchPRDetail(projectId, prNumber, true);
    usePRDetailStore.getState().fetchPRThreads(projectId, prNumber, true);
  };

  // Sort checks: failures first, then pending, then success
  const sortedChecks = detail?.checks
    ? [...detail.checks].sort((a, b) => {
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

  return (
    <div
      className="border-b border-sidebar-border bg-muted/30 px-3 py-2 text-xs"
      data-testid="pr-summary-card"
    >
      {/* Header row */}
      <div className="flex items-center gap-2">
        <a
          href={detail?.html_url ?? prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono font-semibold text-primary hover:underline"
          data-testid="pr-summary-number"
        >
          #{prNumber}
        </a>
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
          <span className="flex items-center gap-1 font-mono text-[10px]">
            <span className="text-diff-added">+{detail.additions}</span>
            <span className="text-diff-removed">-{detail.deletions}</span>
            <span className="text-muted-foreground">· {detail.changed_files} files</span>
          </span>
        )}
        <div className="flex-1" />
        {rateLimited && (
          <Tooltip>
            <TooltipTrigger>
              <span className="text-[10px] text-yellow-500">Rate limited</span>
            </TooltipTrigger>
            <TooltipContent>GitHub API rate limit reached. Polling paused.</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleRefresh}
              disabled={loadingDetail}
              data-testid="pr-summary-refresh"
            >
              <RefreshCw className={cn('h-3 w-3', loadingDetail && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Refresh PR data</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={detail?.html_url ?? prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
              data-testid="pr-summary-external-link"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          </TooltipTrigger>
          <TooltipContent>Open on GitHub</TooltipContent>
        </Tooltip>
      </div>

      {/* PR title */}
      {detail && (
        <p
          className="mt-1 truncate text-[11px] text-muted-foreground"
          title={detail.title}
          data-testid="pr-summary-title"
        >
          {detail.title}
        </p>
      )}

      {/* Status row: review decision + merge status */}
      {detail && (
        <div className="mt-1.5 flex items-center gap-3">
          <ReviewDecisionBadge decision={detail.review_decision} />
          <MergeStatus mergeable={detail.mergeable_state} merged={detail.merged} />
        </div>
      )}

      {/* CI Checks */}
      {detail && totalChecks > 0 && (
        <Collapsible open={checksOpen} onOpenChange={setChecksOpen} className="mt-1.5">
          <CollapsibleTrigger
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            data-testid="pr-summary-checks-toggle"
          >
            {checksOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
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
          <CollapsibleContent>
            <div className="mt-1 space-y-0.5 pl-4" data-testid="pr-summary-checks-list">
              {visibleChecks.map((check) => (
                <div key={check.id} className="flex items-center gap-1.5 text-[10px]">
                  <CheckIcon check={check} />
                  <span className="truncate">{check.name}</span>
                  {check.app_name && (
                    <span className="shrink-0 text-muted-foreground">({check.app_name})</span>
                  )}
                  {check.html_url && (
                    <a
                      href={check.html_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                      data-testid={`pr-check-link-${check.id}`}
                    >
                      <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  )}
                </div>
              ))}
              {hasMoreChecks && !checksOpen && (
                <button
                  className="text-[10px] text-primary hover:underline"
                  onClick={() => setChecksOpen(true)}
                  data-testid="pr-summary-show-more-checks"
                >
                  +{sortedChecks.length - MAX_VISIBLE_CHECKS} more
                </button>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Loading skeleton when no detail yet */}
      {!detail && loadingDetail && (
        <div className="mt-1 flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="text-[10px]">Loading PR details...</span>
        </div>
      )}
    </div>
  );
}
