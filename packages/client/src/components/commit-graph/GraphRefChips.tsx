import { Cloud, CloudCheck, Download, Monitor, Tag, Upload } from 'lucide-react';
import { Fragment, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { HighlightText } from '@/components/ui/highlight-text';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { contrastText } from '@/components/ui/project-chip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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

function branchChipStatusLabel(
  t: ReturnType<typeof useTranslation>['t'],
  ref: FoldedRef,
  summary: GraphBranchSummary | undefined,
) {
  if (ref.kind === 'tag') return t('graph.tag', 'Tag');
  if (!summary) {
    return null;
  }

  switch (summary.state) {
    case 'synced':
      return null;
    case 'ahead':
      return ref.kind === 'local' ? String(summary.ahead) : null;
    case 'behind':
      return ref.kind === 'remote' ? String(summary.behind) : null;
    case 'diverged':
      return t('graph.branchChipDiverged', 'Diverged');
    case 'local-only':
      return null;
    case 'remote-only':
      return null;
  }
}

function BranchRefDetail({
  ref,
  summary,
}: {
  ref: FoldedRef;
  summary: GraphBranchSummary | undefined;
}) {
  const { t } = useTranslation();
  const localLabel = summary?.localRef ?? t('graph.notPresent', 'Not present');
  const remoteLabel = summary?.remoteRef ?? t('graph.notPresent', 'Not present');

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
        <dd className="min-w-0 truncate font-mono" title={localLabel}>
          {localLabel}
        </dd>
        <dt className="text-muted-foreground">{t('graph.origin', 'Origin')}</dt>
        <dd className="min-w-0 truncate font-mono" title={remoteLabel}>
          {remoteLabel}
        </dd>
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
    </div>
  );
}

export function GraphRefChips({
  refs,
  branchSummaryByName,
  actionInProgress,
  color,
  searchQuery,
  onPushBranch,
  onPullCurrentBranch,
}: {
  refs: FoldedRef[];
  branchSummaryByName: ReadonlyMap<string, GraphBranchSummary>;
  actionInProgress: string | null;
  color: string;
  searchQuery: string;
  onPushBranch: (branch: string) => void;
  onPullCurrentBranch: (branch: string) => void;
}) {
  const { t } = useTranslation();
  if (refs.length === 0) return null;

  const textColor = contrastText(color);
  const hasSearchQuery = searchQuery.trim().length > 0;

  return (
    <div className="inline-flex min-w-0 shrink items-center gap-1" data-testid="graph-ref-chips">
      {refs.map((ref) => {
        const branchName = branchNameForRef(ref);
        const summary = branchName ? branchSummaryByName.get(branchName) : undefined;
        const isPushAction =
          ref.kind === 'local' &&
          !!summary &&
          (summary.primaryAction === 'push' || summary.primaryAction === 'publish');
        const isPullAction =
          ref.kind === 'remote' &&
          !!summary &&
          summary.primaryAction === 'pull' &&
          summary.isCurrent;
        const actionKey = isPullAction ? `pull:${branchName}` : `push:${branchName}`;
        const busy = !!branchName && actionInProgress === actionKey;
        const Icon = iconForRef(ref);
        const ActionIcon = isPullAction ? Download : Upload;
        const statusLabel = branchChipStatusLabel(t, ref, summary);
        const displayName = displayNameForRef(ref);

        return (
          <Fragment key={`${ref.kind}:${ref.name}`}>
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
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="start"
                  className="w-72 p-3"
                  onClick={(event) => event.stopPropagation()}
                >
                  <BranchRefDetail ref={ref} summary={summary} />
                </PopoverContent>
              </Popover>
            </div>

            {(isPushAction || isPullAction) && branchName && summary ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="default"
                    size="xs"
                    aria-label={branchActionTooltip(t, summary)}
                    className="h-auto min-h-0 shrink-0 gap-0.5 rounded-full px-1.5 py-px text-[10px] leading-tight font-semibold [&_svg]:!size-2.5"
                    disabled={!!actionInProgress}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (isPushAction) onPushBranch(branchName);
                      else onPullCurrentBranch(branchName);
                    }}
                    data-testid={`graph-branch-action-${branchName}`}
                  >
                    {statusLabel ? (
                      <span data-testid={`graph-branch-status-${ref.name}`}>{statusLabel}</span>
                    ) : (
                      <span>{branchActionLabel(t, summary)}</span>
                    )}
                    <ActionIcon
                      className={cn(busy && 'animate-pulse')}
                      data-testid={`graph-branch-action-icon-${branchName}`}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{branchActionTooltip(t, summary)}</TooltipContent>
              </Tooltip>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}
