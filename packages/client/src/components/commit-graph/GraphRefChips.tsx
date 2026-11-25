import {
  Check,
  CheckCircle2,
  Cloud,
  CloudCheck,
  CloudDownload,
  Copy,
  Download,
  ExternalLink,
  Monitor,
  MonitorUp,
  RefreshCw,
  Tag,
  Upload,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { HighlightText } from '@/components/ui/highlight-text';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { contrastText, darkenHex } from '@/components/ui/project-chip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { githubBranchUrl } from '@/lib/github-url';
import type { FoldedRef, GraphBranchSummary } from '@/lib/graph-refs';
import { cn } from '@/lib/utils';

/**
 * Height of one ref chip and the gap between stacked chips, in px (not rem).
 * The commit graph places the node and its leader line at the first chip's
 * center with px arithmetic (`CommitGraphTab`'s row heights and `nodeYForRow`),
 * so the chips must have exactly these sizes. Rem sizes shrink with the root
 * font size and the vertically centered stack drifts below the node, by more
 * with every extra chip.
 */
export const GRAPH_REF_CHIP_HEIGHT_PX = 15;
export const GRAPH_REF_CHIP_GAP_PX = 4;

/**
 * Size of the thread-branch arrowhead and its gap to the chip, in px: the
 * emphasized leader line stops at the arrowhead's base (`GraphCommitRow`), so
 * the head, not the line's round cap, is the arrow's tip.
 */
export const THREAD_BRANCH_MARKER_WIDTH_PX = 7;
const THREAD_BRANCH_MARKER_HEIGHT_PX = 10;
export const THREAD_BRANCH_MARKER_GAP_PX = 2;

function branchStateLabel(t: ReturnType<typeof useTranslation>['t'], branch: GraphBranchSummary) {
  switch (branch.state) {
    case 'synced':
      return t('graph.branchStateSynced', 'Synced');
    case 'ahead':
      return t('graph.branchStateAhead', {
        count: branch.ahead,
        defaultValue: `Ahead ${branch.ahead}`,
      });
    case 'behind':
      return t('graph.branchStateBehind', {
        count: branch.behind,
        defaultValue: `Behind ${branch.behind}`,
      });
    case 'diverged':
      return t('graph.branchStateDiverged', {
        ahead: branch.ahead,
        behind: branch.behind,
        defaultValue: `Diverged ${branch.ahead}/${branch.behind}`,
      });
    case 'local-only':
      return t('graph.branchStateLocalOnly', 'Local only');
    case 'remote-only':
      return t('graph.branchStateRemoteOnly', 'Remote only');
  }
}

function branchActionLabel(t: ReturnType<typeof useTranslation>['t'], branch: GraphBranchSummary) {
  switch (branch.primaryAction) {
    case 'push':
      return t('review.push', 'Push');
    case 'pull':
      return t('review.pull', 'Pull');
    case 'publish':
      return t('graph.publishBranch', 'Publish');
    case 'checkout':
      return t('history.checkout', 'Checkout');
    case 'sync':
      return t('graph.syncBranch', 'Sync');
    case 'none':
      return t('graph.noBranchAction', 'Up to date');
  }
}

function branchActionTooltip(
  t: ReturnType<typeof useTranslation>['t'],
  branch: GraphBranchSummary,
) {
  if (branch.primaryAction === 'push' || branch.primaryAction === 'publish') {
    return t('graph.pushBranchToOrigin', {
      branch: branch.branch,
      defaultValue: `Push ${branch.branch} to origin`,
    });
  }
  if (branch.primaryAction === 'pull' && branch.isCurrent) {
    return t('review.pull', 'Pull');
  }
  if (branch.primaryAction === 'checkout') {
    return t('graph.checkoutBeforePull', 'Checkout this branch first');
  }
  if (branch.primaryAction === 'sync') {
    return t('graph.syncBranchFromHistory', 'Use History to choose merge or rebase');
  }
  return branchActionLabel(t, branch);
}

function remoteBranchName(refName: string): string {
  const slash = refName.indexOf('/');
  return slash >= 0 ? refName.slice(slash + 1) : refName;
}

function branchNameForRef(ref: FoldedRef): string | null {
  if (ref.kind === 'tag' || ref.name === 'HEAD') return null;
  return ref.kind === 'remote' ? remoteBranchName(ref.name) : ref.name;
}

function displayNameForRef(ref: FoldedRef): string {
  return ref.kind === 'remote' ? remoteBranchName(ref.name) : ref.name;
}

/** True when `ref` is the local branch the open thread works on. */
export function isThreadBranchRef(
  ref: FoldedRef,
  threadBranch: string | null | undefined,
): boolean {
  return !!threadBranch && ref.kind === 'local' && ref.name === threadBranch;
}

/**
 * Arrowhead in front of the chip of the branch the open thread lives on, so
 * clicking a thread shows where it sits in the history. Only the head is drawn:
 * the row's leader line is the shaft (the commit row puts the thread's chip
 * first, see `pinThreadBranchFirst`), so the two read as one arrow.
 */
function ThreadBranchMarker({ branch, color }: { branch: string; color: string }) {
  const { t } = useTranslation();
  const label = t('graph.threadBranchMarker', {
    branch,
    defaultValue: `This thread works on ${branch}`,
  });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          className="inline-flex shrink-0 items-center text-[color:var(--graph-thread-marker-color)]"
          style={{ '--graph-thread-marker-color': color }}
          data-testid="graph-thread-branch-marker"
        >
          <svg
            viewBox="0 0 7 10"
            width={THREAD_BRANCH_MARKER_WIDTH_PX}
            height={THREAD_BRANCH_MARKER_HEIGHT_PX}
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M0 0 L7 5 L0 10 Z" />
          </svg>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Where the ref lives: local only, remote only, both on this commit (folded), or
 * a tag. A branch that exists on one side only gets the "upload" / "download"
 * variant, so the chip needs no separate status badge to say it.
 */
function renderRefIcon(ref: FoldedRef, summary: GraphBranchSummary | undefined) {
  const props = {
    className: 'icon-2xs shrink-0',
    'aria-hidden': true,
    'data-testid': `graph-ref-icon-${ref.name}`,
  } as const;
  if (ref.kind === 'tag') return <Tag {...props} />;
  if (ref.kind === 'remote') {
    return summary?.state === 'remote-only' ? <CloudDownload {...props} /> : <Cloud {...props} />;
  }
  if (ref.syncedRemote) return <CloudCheck {...props} />;
  return summary?.state === 'local-only' ? <MonitorUp {...props} /> : <Monitor {...props} />;
}

/**
 * A branch whose PR is merged. After a squash merge its own commits never join
 * the base branch, so the graph still draws its lane: the chip says the code
 * is already there instead of looking like pending work.
 */
function isMergedRef(ref: FoldedRef): boolean {
  return ref.pullRequest?.state === 'MERGED';
}

function tooltipForRef(
  t: ReturnType<typeof useTranslation>['t'],
  ref: FoldedRef,
  summary: GraphBranchSummary | undefined,
) {
  const pullRequestTooltip = !ref.pullRequest
    ? null
    : isMergedRef(ref)
      ? t('graph.pullRequestMerged', {
          number: ref.pullRequest.number,
          defaultValue: `PR #${ref.pullRequest.number} merged — its code is already in the base branch`,
        })
      : t('graph.pullRequest', {
          number: ref.pullRequest.number,
          state: ref.pullRequest.state,
          defaultValue: `PR #${ref.pullRequest.number} (${ref.pullRequest.state})`,
        });

  let refTooltip: string;
  if (ref.kind === 'tag') {
    refTooltip = ref.name;
  } else if (ref.kind === 'remote') {
    refTooltip = t('graph.remoteBranch', {
      ref: ref.name,
      defaultValue: `${ref.name} (remote branch)`,
    });
  } else if (ref.syncedRemote) {
    refTooltip = t('graph.branchSynced', {
      ref: ref.name,
      remote: ref.syncedRemote,
      defaultValue: ref.isCurrent
        ? `${ref.name} (current branch · in sync with ${ref.syncedRemote})`
        : `${ref.name} (in sync with ${ref.syncedRemote})`,
    });
  } else {
    refTooltip = ref.isCurrent
      ? t('graph.currentBranch', {
          ref: ref.name,
          defaultValue: `${ref.name} (current branch)`,
        })
      : ref.name;
  }

  return [refTooltip, summary ? branchStateLabel(t, summary) : null, pullRequestTooltip]
    .filter(Boolean)
    .join(' · ');
}

function branchChipStatusMeta(
  t: ReturnType<typeof useTranslation>['t'],
  ref: FoldedRef,
  summary: GraphBranchSummary | undefined,
) {
  if (ref.kind === 'tag') return null;
  if (!summary) {
    return null;
  }

  // The badge only says what the ref icon cannot: how far the branch is ahead,
  // behind or diverged. "Synced" (the folded chip's cloud-check icon) and
  // "local / remote only" (the monitor-up / cloud-down icons) are in the icon.
  switch (summary.state) {
    case 'synced':
      return ref.kind === 'local' && ref.syncedRemote
        ? null
        : {
            icon: CheckCircle2,
            label: null,
            tooltip: branchStateLabel(t, summary),
          };
    case 'ahead':
      return ref.kind === 'local'
        ? {
            icon: Upload,
            label: String(summary.ahead),
            tooltip: branchStateLabel(t, summary),
          }
        : null;
    case 'behind':
      return ref.kind === 'remote'
        ? {
            icon: Download,
            label: String(summary.behind),
            tooltip: branchStateLabel(t, summary),
          }
        : null;
    case 'diverged':
      return {
        icon: RefreshCw,
        label: `${summary.ahead}/${summary.behind}`,
        tooltip: branchStateLabel(t, summary),
      };
    case 'local-only':
    case 'remote-only':
      return null;
  }
}

function branchActionForRef(ref: FoldedRef, summary: GraphBranchSummary | undefined) {
  if (!summary) return null;
  if (
    ref.kind === 'local' &&
    (summary.primaryAction === 'push' || summary.primaryAction === 'publish')
  ) {
    return { icon: Upload, key: `push:${summary.branch}`, type: 'push' as const };
  }
  if (ref.kind === 'remote' && summary.primaryAction === 'pull' && summary.isCurrent) {
    return { icon: Download, key: `pull:${summary.branch}`, type: 'pull' as const };
  }
  return null;
}

function BranchChipStatus({
  gitRef,
  summary,
}: {
  gitRef: FoldedRef;
  summary: GraphBranchSummary | undefined;
}) {
  const { t } = useTranslation();
  const status = branchChipStatusMeta(t, gitRef, summary);
  if (!status) return null;

  const StatusIcon = status.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="text-3xs inline-flex shrink-0 items-center gap-0.5 rounded-full bg-black/15 px-1 py-px leading-none font-semibold"
          data-testid={`graph-branch-status-${gitRef.name}`}
        >
          <StatusIcon
            className="icon-2xs"
            aria-hidden="true"
            data-testid={`graph-branch-status-icon-${gitRef.name}`}
          />
          {status.label ? <span>{status.label}</span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{status.tooltip}</TooltipContent>
    </Tooltip>
  );
}

function CopyableRefValue({
  kind,
  value,
}: {
  kind: 'local' | 'remote';
  value: string | undefined;
}) {
  const { t } = useTranslation();
  const [copied, copy] = useCopyToClipboard();
  const label = value ?? t('graph.notPresent', 'Not present');

  return (
    <dd className="group/ref-value flex min-w-0 items-center gap-1 font-mono">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </TooltipTrigger>
        <TooltipContent variant="mono">{label}</TooltipContent>
      </Tooltip>
      {value ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="focus-visible:ring-ring/70 inline-flex size-4 shrink-0 items-center justify-center rounded-sm opacity-0 outline-hidden transition-opacity group-hover/ref-value:opacity-100 focus-visible:opacity-100 focus-visible:ring-1"
              aria-label={
                copied
                  ? t('graph.copiedRef', 'Copied {{ref}}', { ref: value })
                  : t('graph.copyRef', 'Copy {{ref}}', { ref: value })
              }
              onClick={(event) => {
                event.stopPropagation();
                copy(value);
              }}
              data-testid={`graph-branch-copy-${kind}-${value}`}
            >
              {copied ? (
                <Check className="icon-2xs copy-feedback-icon text-status-success" />
              ) : (
                <Copy className="icon-2xs copy-feedback-icon" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {copied
              ? t('graph.copiedRef', 'Copied {{ref}}', { ref: value })
              : t('graph.copyRef', 'Copy {{ref}}', { ref: value })}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </dd>
  );
}

function BranchRefDetail({
  gitRef,
  summary,
  githubBrowseBaseUrl,
  actionInProgress,
  onPushBranch,
  onPullCurrentBranch,
}: {
  gitRef: FoldedRef;
  summary: GraphBranchSummary | undefined;
  githubBrowseBaseUrl: string | null;
  actionInProgress: string | null;
  onPushBranch: (branch: string) => void;
  onPullCurrentBranch: (branch: string) => void;
}) {
  const { t } = useTranslation();
  const action = branchActionForRef(gitRef, summary);
  const ActionIcon = action?.icon;
  const busy = !!action && actionInProgress === action.key;
  const githubUrl =
    githubBrowseBaseUrl && summary?.remoteRef
      ? githubBranchUrl(githubBrowseBaseUrl, summary.branch)
      : null;

  return (
    <div className="flex flex-col gap-3 text-xs" data-testid={`graph-branch-detail-${gitRef.name}`}>
      <div className="min-w-0">
        <div className="text-muted-foreground text-2xs font-medium uppercase">
          {t('graph.branch', 'Branch')}
        </div>
        <div className="truncate font-mono font-semibold">{summary?.branch ?? gitRef.name}</div>
      </div>

      <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="text-muted-foreground">{t('graph.local', 'Local')}</dt>
        <CopyableRefValue kind="local" value={summary?.localRef} />
        <dt className="text-muted-foreground">{t('graph.origin', 'Origin')}</dt>
        <CopyableRefValue kind="remote" value={summary?.remoteRef} />
        {summary ? (
          <>
            <dt className="text-muted-foreground">{t('graph.state', 'State')}</dt>
            <dd>{branchStateLabel(t, summary)}</dd>
            <dt className="text-muted-foreground">{t('graph.localAhead', 'Ahead')}</dt>
            <dd>{summary.ahead}</dd>
            <dt className="text-muted-foreground">{t('graph.originAhead', 'Behind')}</dt>
            <dd>{summary.behind}</dd>
            <dt className="text-muted-foreground">{t('graph.action', 'Action')}</dt>
            <dd>{branchActionTooltip(t, summary)}</dd>
          </>
        ) : null}
      </dl>

      {(githubUrl || (summary && action && ActionIcon)) && (
        <div className="border-border/70 flex border-t pt-3">
          <div className="flex flex-wrap gap-2">
            {githubUrl ? (
              <Button asChild type="button" variant="outline" size="xs" className="gap-1.5">
                <a
                  href={githubUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`graph-branch-github-${summary?.branch}`}
                >
                  <ExternalLink className="icon-sm" aria-hidden="true" />
                  {t('graph.viewBranchOnGithub', 'View branch on GitHub')}
                </a>
              </Button>
            ) : null}
            {summary && action && ActionIcon ? (
              <Button
                type="button"
                variant="default"
                size="xs"
                aria-label={branchActionTooltip(t, summary)}
                className="gap-1.5"
                disabled={!!actionInProgress}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (action.type === 'push') onPushBranch(summary.branch);
                  else onPullCurrentBranch(summary.branch);
                }}
                data-testid={`graph-branch-action-${summary.branch}`}
              >
                <ActionIcon
                  className={cn('icon-sm', busy && 'animate-pulse')}
                  data-testid={`graph-branch-action-icon-${summary.branch}`}
                />
                {branchActionLabel(t, summary)}
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function GraphRefChip({
  gitRef,
  summary,
  githubBrowseBaseUrl,
  actionInProgress,
  color,
  textColor,
  hasSearchQuery,
  searchQuery,
  isThreadBranch,
  onPushBranch,
  onPullCurrentBranch,
}: {
  gitRef: FoldedRef;
  summary: GraphBranchSummary | undefined;
  githubBrowseBaseUrl: string | null;
  actionInProgress: string | null;
  color: string;
  textColor: string;
  hasSearchQuery: boolean;
  searchQuery: string;
  isThreadBranch: boolean;
  onPushBranch: (branch: string) => void;
  onPullCurrentBranch: (branch: string) => void;
}) {
  const { t } = useTranslation();
  const displayName = displayNameForRef(gitRef);

  return (
    <div
      // A merged PR is told by its badge and tooltip, not by fading the chip:
      // opacity would also fade the name and let the row show through.
      className={cn(
        'inline-flex h-[var(--graph-ref-chip-height)] max-w-full min-w-0 shrink-0 items-center gap-0.5 rounded-full bg-[color:var(--graph-ref-chip-bg)] px-1 py-px text-[color:var(--graph-ref-chip-fg)] transition-[filter] hover:brightness-90',
        // The thread's chip is outlined in a darker shade of its own color. The
        // ring is inset: the refs line clips at the chip's exact height, so an
        // outer ring would be cut at the top and bottom.
        isThreadBranch && '[box-shadow:inset_0_0_0_1.5px_var(--graph-ref-chip-outline)]',
      )}
      style={{
        '--graph-ref-chip-height': `${GRAPH_REF_CHIP_HEIGHT_PX}px`,
        '--graph-ref-chip-bg': color,
        '--graph-ref-chip-fg': textColor,
        '--graph-ref-chip-outline': isThreadBranch ? darkenHex(color, 0.35) : undefined,
      }}
      data-testid={`graph-ref-chip-${gitRef.kind}:${gitRef.name}`}
      data-merged={isMergedRef(gitRef) || undefined}
      data-thread-branch={isThreadBranch || undefined}
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="focus-visible:ring-ring/70 inline-flex min-w-0 items-center gap-0.5 rounded-full px-0.5 text-left outline-hidden focus-visible:ring-1"
            aria-label={tooltipForRef(t, gitRef, summary)}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            data-testid={`graph-branch-info-${gitRef.name}`}
          >
            {renderRefIcon(gitRef, summary)}
            <span
              className={cn(
                'truncate text-2xs leading-tight font-medium whitespace-nowrap',
                gitRef.kind === 'local' && gitRef.isCurrent && 'font-bold',
              )}
            >
              {hasSearchQuery ? (
                <HighlightText text={displayName} query={searchQuery} />
              ) : (
                displayName
              )}
            </span>
            <BranchChipStatus gitRef={gitRef} summary={summary} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          className="w-72 p-3"
          onClick={(event) => event.stopPropagation()}
        >
          <BranchRefDetail
            gitRef={gitRef}
            summary={summary}
            githubBrowseBaseUrl={githubBrowseBaseUrl}
            actionInProgress={actionInProgress}
            onPushBranch={onPushBranch}
            onPullCurrentBranch={onPullCurrentBranch}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function GraphRefChips({
  refs,
  branchSummaryByName,
  githubBrowseBaseUrl = null,
  actionInProgress,
  color,
  searchQuery,
  threadBranch = null,
  onPushBranch,
  onPullCurrentBranch,
}: {
  refs: FoldedRef[];
  branchSummaryByName: ReadonlyMap<string, GraphBranchSummary>;
  githubBrowseBaseUrl?: string | null;
  actionInProgress: string | null;
  color: string;
  searchQuery: string;
  /** Branch the open thread works on; its chip gets an arrow marker. */
  threadBranch?: string | null;
  onPushBranch: (branch: string) => void;
  onPullCurrentBranch: (branch: string) => void;
}) {
  if (refs.length === 0) return null;

  const textColor = contrastText(color);
  const hasSearchQuery = searchQuery.trim().length > 0;

  return (
    <div
      className="inline-flex min-w-0 shrink flex-col items-start gap-[var(--graph-ref-chips-gap)]"
      style={{ '--graph-ref-chips-gap': `${GRAPH_REF_CHIP_GAP_PX}px` }}
      data-testid="graph-ref-chips"
    >
      {refs.map((gitRef) => {
        const branchName = branchNameForRef(gitRef);
        const summary = branchName ? branchSummaryByName.get(branchName) : undefined;
        const isThreadBranch = isThreadBranchRef(gitRef, threadBranch);

        const chip = (
          <GraphRefChip
            key={`${gitRef.kind}:${gitRef.name}`}
            gitRef={gitRef}
            summary={summary}
            githubBrowseBaseUrl={githubBrowseBaseUrl}
            actionInProgress={actionInProgress}
            color={color}
            textColor={textColor}
            hasSearchQuery={hasSearchQuery}
            searchQuery={searchQuery}
            isThreadBranch={isThreadBranch}
            onPushBranch={onPushBranch}
            onPullCurrentBranch={onPullCurrentBranch}
          />
        );
        if (!isThreadBranch) return chip;
        // The marker hangs in the gap LEFT of the chip (absolute), so marking the
        // thread's branch never shifts its chip out of line with the others.
        return (
          <div
            key={`${gitRef.kind}:${gitRef.name}`}
            className="relative flex max-w-full min-w-0 items-center"
          >
            <span
              className="absolute top-1/2 right-full mr-[var(--thread-branch-marker-gap)] inline-flex -translate-y-1/2"
              style={{ '--thread-branch-marker-gap': `${THREAD_BRANCH_MARKER_GAP_PX}px` }}
            >
              <ThreadBranchMarker branch={gitRef.name} color={color} />
            </span>
            {chip}
          </div>
        );
      })}
    </div>
  );
}
