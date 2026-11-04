import type { CICheck, PRDetail } from '@funny/shared';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Loader2,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';

import { PRCompactIdentity } from '@/components/pull-requests/PRCompactIdentity';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { LoadingState } from '@/components/ui/loading-state';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePRDetail, usePRPolling } from '@/data/pull-requests/hooks';
import { sortChecks } from '@/lib/ci-checks';

export { MergeStatus, ReviewDecisionBadge } from '@/components/pull-requests/PRStatusBadges';

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
    return <Loader2 className="icon-sm shrink-0 animate-spin text-yellow-500" />;
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

export function PRSummaryCard({
  projectId,
  prNumber,
  prUrl,
  prState,
  visible,
}: PRSummaryCardProps) {
  const { detail, loadingDetail, rateLimited } = usePRDetail(projectId, prNumber);
  usePRPolling(projectId, prNumber, visible, { threads: true });

  const detailPrState = detail?.merged ? 'MERGED' : detail?.state === 'closed' ? 'CLOSED' : prState;
  const compactPr = detail ?? {
    number: prNumber,
    html_url: prUrl,
    state: prState === 'CLOSED' ? 'closed' : 'open',
    merged: prState === 'MERGED',
  };

  return (
    <div
      className="border-sidebar-border bg-muted/30 border-b px-3 py-2 text-xs"
      data-testid="pr-summary-card"
    >
      <PRCompactIdentity
        pr={compactPr}
        fallbackState={detailPrState}
        numberTestId="pr-summary-number"
        titleTestId="pr-summary-title"
        mergeLineTestId="pr-summary-merge-info"
        metaTestId="pr-summary-meta"
        statusTestId="pr-summary-status"
        showStateBadge
        stats={
          detail
            ? {
                additions: detail.additions,
                deletions: detail.deletions,
                changedFiles: detail.changed_files,
              }
            : null
        }
        reviewDecision={detail?.review_decision}
        titleExtra={
          rateLimited ? (
            <Tooltip>
              <TooltipTrigger>
                <span className="shrink-0 text-[11px] text-yellow-500">Rate limited</span>
              </TooltipTrigger>
              <TooltipContent>GitHub API rate limit reached. Polling paused.</TooltipContent>
            </Tooltip>
          ) : null
        }
      />

      {detail && <PRChecksSection detail={detail} />}

      {/* Loading skeleton when no detail yet */}
      {!detail && loadingDetail && (
        <LoadingState fill={false} layout="inline" className="mt-1" label="Loading PR details…" />
      )}
    </div>
  );
}

/** Line 3 of the card: the PR's CI checks, collapsed to the first few. */
function PRChecksSection({ detail }: { detail: PRDetail }) {
  const [checksOpen, setChecksOpen] = useState(false);
  const sortedChecks = sortChecks(detail.checks);
  const totalChecks = sortedChecks.length;
  if (totalChecks === 0) return null;

  const visibleChecks = checksOpen ? sortedChecks : sortedChecks.slice(0, MAX_VISIBLE_CHECKS);
  const hasMoreChecks = totalChecks > MAX_VISIBLE_CHECKS;

  return (
    <Collapsible open={checksOpen} onOpenChange={setChecksOpen} className="mt-1.5">
      <div className="flex items-center gap-3">
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
      </div>
      <CollapsibleContent>
        <div className="mt-1 space-y-0.5 pl-4" data-testid="pr-summary-checks-list">
          {visibleChecks.map((check) => (
            <PRCheckRow key={check.id} check={check} />
          ))}
          {hasMoreChecks && !checksOpen && (
            <button
              className="text-primary text-[11px] hover:underline"
              onClick={() => setChecksOpen(true)}
              data-testid="pr-summary-show-more-checks"
            >
              +{totalChecks - MAX_VISIBLE_CHECKS} more
            </button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function PRCheckRow({ check }: { check: CICheck }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <CheckIcon check={check} />
      {check.html_url ? (
        <a
          href={check.html_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground min-w-0 truncate hover:underline"
          data-testid={`pr-check-link-${check.id}`}
        >
          {check.name}
        </a>
      ) : (
        <span className="truncate">{check.name}</span>
      )}
      {check.app_name && <span className="text-muted-foreground shrink-0">({check.app_name})</span>}
    </div>
  );
}
