import {
  Check,
  CheckCircle2,
  Cloud,
  CloudCheck,
  Copy,
  Download,
  ExternalLink,
  Monitor,
  RefreshCw,
  Tag,
  Upload,
} from 'lucide-react';
import { type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { HighlightText } from '@/components/ui/highlight-text';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { contrastText } from '@/components/ui/project-chip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { githubBranchUrl } from '@/lib/github-url';
import type { FoldedRef, GraphBranchSummary } from '@/lib/graph-refs';
import { cn } from '@/lib/utils';

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

function iconForRef(ref: FoldedRef): ComponentType<{ className?: string }> {
  if (ref.kind === 'tag') return Tag;
  if (ref.kind === 'remote') return Cloud;
  return ref.syncedRemote ? CloudCheck : Monitor;
}

function tooltipForRef(
  t: ReturnType<typeof useTranslation>['t'],
  ref: FoldedRef,
  summary: GraphBranchSummary | undefined,
) {
  const pullRequestTooltip = ref.pullRequest
    ? t('graph.pullRequest', {
        number: ref.pullRequest.number,
        state: ref.pullRequest.state,
        defaultValue: `PR #${ref.pullRequest.number} (${ref.pullRequest.state})`,
      })
    : null;

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

  switch (summary.state) {
    case 'synced':
      return {
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
      return ref.kind === 'local'
        ? {
            icon: Upload,
            label: null,
            tooltip: branchStateLabel(t, summary),
          }
        : null;
    case 'remote-only':
      return ref.kind === 'remote'
        ? {
            icon: Download,
            label: null,
            tooltip: branchStateLabel(t, summary),
          }
        : null;
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
  ref,
  summary,
}: {
  ref: FoldedRef;
  summary: GraphBranchSummary | undefined;
}) {
  const { t } = useTranslation();
  const status = branchChipStatusMeta(t, ref, summary);
  if (!status) return null;

  const StatusIcon = status.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-black/15 px-1 py-px text-[9px] leading-none font-semibold"
          data-testid={`graph-branch-status-${ref.name}`}
        >
          <StatusIcon
            className="icon-2xs"
            aria-hidden="true"
            data-testid={`graph-branch-status-icon-${ref.name}`}
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
        <TooltipContent className="max-w-[min(28rem,calc(100vw-2rem))] font-mono break-all">
          {label}
        </TooltipContent>
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
              {copied ? <Check className="icon-2xs" /> : <Copy className="icon-2xs" />}
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
  ref,
  summary,
  githubBrowseBaseUrl,
  actionInProgress,
  onPushBranch,
  onPullCurrentBranch,
}: {
  ref: FoldedRef;
  summary: GraphBranchSummary | undefined;
  githubBrowseBaseUrl: string | null;
  actionInProgress: string | null;
  onPushBranch: (branch: string) => void;
  onPullCurrentBranch: (branch: string) => void;
}) {
  const { t } = useTranslation();
  const action = branchActionForRef(ref, summary);
  const ActionIcon = action?.icon;
  const busy = !!action && actionInProgress === action.key;
  const githubUrl =
    githubBrowseBaseUrl && summary?.remoteRef
      ? githubBranchUrl(githubBrowseBaseUrl, summary.branch)
      : null;

  return (
    <div className="flex flex-col gap-3 text-xs" data-testid={`graph-branch-detail-${ref.name}`}>
      <div className="min-w-0">
        <div className="text-muted-foreground text-[10px] font-medium uppercase">
          {t('graph.branch', 'Branch')}
        </div>
        <div className="truncate font-mono font-semibold">{summary?.branch ?? ref.name}</div>
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
              <Button
                asChild
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
              >
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
                size="sm"
                aria-label={branchActionTooltip(t, summary)}
                className="h-7 gap-1.5 px-2 text-xs"
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
  ref,
  summary,
  githubBrowseBaseUrl,
  actionInProgress,
  color,
  textColor,
  hasSearchQuery,
  searchQuery,
  onPushBranch,
  onPullCurrentBranch,
}: {
  ref: FoldedRef;
  summary: GraphBranchSummary | undefined;
  githubBrowseBaseUrl: string | null;
  actionInProgress: string | null;
  color: string;
  textColor: string;
  hasSearchQuery: boolean;
  searchQuery: string;
  onPushBranch: (branch: string) => void;
  onPullCurrentBranch: (branch: string) => void;
}) {
  const { t } = useTranslation();
  const Icon = iconForRef(ref);
  const displayName = displayNameForRef(ref);

  return (
    <div
      className="inline-flex min-w-0 items-center gap-0.5 rounded-full px-1 py-px transition-[filter] hover:brightness-90"
      style={{ backgroundColor: color, color: textColor }}
      data-testid={`graph-ref-chip-${ref.kind}:${ref.name}`}
    >
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="focus-visible:ring-ring/70 inline-flex min-w-0 items-center gap-0.5 rounded-full px-0.5 text-left outline-hidden focus-visible:ring-1"
            aria-label={tooltipForRef(t, ref, summary)}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            data-testid={`graph-branch-info-${ref.name}`}
          >
            <Icon className="icon-2xs shrink-0" aria-hidden="true" />
            <span
              className={cn(
                'truncate text-[10px] leading-tight font-medium whitespace-nowrap',
                ref.kind === 'local' && ref.isCurrent && 'font-bold',
              )}
            >
              {hasSearchQuery ? (
                <HighlightText text={displayName} query={searchQuery} />
              ) : (
                displayName
              )}
            </span>
            <BranchChipStatus ref={ref} summary={summary} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          className="w-72 p-3"
          onClick={(event) => event.stopPropagation()}
        >
          <BranchRefDetail
            ref={ref}
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
  onPushBranch,
  onPullCurrentBranch,
}: {
  refs: FoldedRef[];
  branchSummaryByName: ReadonlyMap<string, GraphBranchSummary>;
  githubBrowseBaseUrl?: string | null;
  actionInProgress: string | null;
  color: string;
  searchQuery: string;
  onPushBranch: (branch: string) => void;
  onPullCurrentBranch: (branch: string) => void;
}) {
  if (refs.length === 0) return null;

  const textColor = contrastText(color);
  const hasSearchQuery = searchQuery.trim().length > 0;

  return (
    <div className="inline-flex min-w-0 shrink items-center gap-1" data-testid="graph-ref-chips">
      {refs.map((ref) => {
        const branchName = branchNameForRef(ref);
        const summary = branchName ? branchSummaryByName.get(branchName) : undefined;

        return (
          <GraphRefChip
            key={`${ref.kind}:${ref.name}`}
            ref={ref}
            summary={summary}
            githubBrowseBaseUrl={githubBrowseBaseUrl}
            actionInProgress={actionInProgress}
            color={color}
            textColor={textColor}
            hasSearchQuery={hasSearchQuery}
            searchQuery={searchQuery}
            onPushBranch={onPushBranch}
            onPullCurrentBranch={onPullCurrentBranch}
          />
        );
      })}
    </div>
  );
}
