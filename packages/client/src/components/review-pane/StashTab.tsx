import { Archive, ArchiveRestore, FileCode, Loader2, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { BranchBadge } from '@/components/BranchBadge';
import { FileTree } from '@/components/FileTree';
import { ExpandedDiffView } from '@/components/tool-cards/ExpandedDiffDialog';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import type { UseStashStateResult } from '@/hooks/use-stash-state';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';
import {
  listRowActionBusyClassName,
  listRowActionClassName,
  listRowClassName,
  listRowTitleClassName,
} from '@/lib/list-row-styles';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

import { TabToolbar, TabToolbarRefresh, TabToolbarSpacer } from './TabToolbar';
import { ToolbarCount } from './ToolbarCount';

interface StashTabProps {
  stash: UseStashStateResult;
  currentBranch: string | undefined;
  isAgentRunning: boolean;
  /** Caller opens its confirm dialog; the drop is executed via stash.executeStashDrop. */
  onRequestDrop: (stashIndex: string) => void;
}

export function StashTab({ stash, currentBranch, isAgentRunning, onRequestDrop }: StashTabProps) {
  const { t } = useTranslation();
  const now = useMinuteTick();
  const {
    stashEntries,
    filteredStashEntries,
    otherBranchStashGroups,
    selectedStashIndex,
    setSelectedStashIndex,
    selectedStashEntry,
    stashFiles,
    stashTreeFiles,
    stashFilesLoading,
    stashDialogFile,
    stashDialogDiff,
    stashDialogDiffLoading,
    stashDialogDiffCache,
    stashFileSearch,
    setStashFileSearch,
    stashFileSearchCaseSensitive,
    setStashFileSearchCaseSensitive,
    stashPopInProgress,
    stashDropInProgress,
    stashListLoading,
    handleStashPop,
    loadStashFileDiff,
    refreshStashList,
  } = stash;

  const noStashesTitle = currentBranch
    ? t('review.noStashesOnBranch', {
        branch: currentBranch,
        defaultValue: `No stashed changes on ${currentBranch}`,
      })
    : t('review.noStashes', 'No stashed changes');

  const toolbar = (
    <StashToolbar
      loading={stashListLoading}
      count={stashEntries.length}
      onRefresh={() => void refreshStashList()}
    />
  );

  if (stashEntries.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {toolbar}
        <EmptyState icon={Archive} title={noStashesTitle} />
      </div>
    );
  }

  const rowProps = {
    now,
    isAgentRunning,
    stashPopInProgress,
    stashDropInProgress,
    onSelect: setSelectedStashIndex,
    onPop: handleStashPop,
    onRequestDrop,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {toolbar}
      <ScrollArea className="flex min-h-0 flex-1 flex-col">
        {/* One list: this branch's stashes first (branch chip outlined), then the
            other branches' — each row names its branch, like the worktrees. */}
        <div className="divide-sidebar-border flex flex-col divide-y" data-testid="stash-list">
          {filteredStashEntries.map((entry) => (
            <StashRow
              key={entry.index}
              entry={entry}
              branch={currentBranch}
              current
              {...rowProps}
            />
          ))}
          {otherBranchStashGroups.flatMap((group) =>
            group.entries.map((entry) => (
              <StashRow
                key={entry.index}
                entry={entry}
                branch={group.branch}
                otherBranch={group.branch}
                {...rowProps}
              />
            )),
          )}
        </div>
      </ScrollArea>

      {/* Stash detail dialog */}
      <Dialog
        open={!!selectedStashIndex}
        onOpenChange={(open) => {
          if (!open) setSelectedStashIndex(null);
        }}
      >
        <DialogContent
          flush
          className="flex h-[85vh] max-w-[90vw] flex-col"
          data-testid="stash-detail-dialog"
        >
          <div className="border-border shrink-0 border-b px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <DialogTitle size="sm" className="leading-tight">
                {selectedStashEntry?.message ?? t('review.stashDetails', 'Stash details')}
              </DialogTitle>
              <Button
                variant="muted"
                size="icon-xs"
                onClick={() => setSelectedStashIndex(null)}
                className="shrink-0"
                data-testid="stash-detail-close"
              >
                <X className="icon-xs" />
              </Button>
            </div>
            <DialogDescription className="sr-only">
              {t('review.stashDetailsDesc', 'Stash detail with file changes and diffs')}
            </DialogDescription>
            {selectedStashEntry && (
              <div className="text-muted-foreground text-compact flex items-center gap-1.5 pt-1">
                <Archive className="icon-xs shrink-0" />
                <code className="text-primary shrink-0 font-mono">{selectedStashEntry.index}</code>
                <span className="shrink-0">{timeAgo(selectedStashEntry.createdAt, t, now)}</span>
                <span className="text-muted-foreground shrink-0">
                  &middot; {stashFiles.length} file{stashFiles.length !== 1 ? 's' : ''}
                </span>
              </div>
            )}
          </div>

          {stashFilesLoading ? (
            <LoadingState
              testId="stash-detail-loading"
              label={t('review.loading', 'Loading changes…')}
            />
          ) : (
            <div className="flex min-h-0 flex-1">
              <div
                className="border-border flex w-[280px] shrink-0 flex-col border-r"
                data-testid="stash-detail-file-tree"
              >
                {stashFiles.length > 0 && (
                  <div className="border-sidebar-border shrink-0 border-b px-2 py-1">
                    <SearchBar
                      query={stashFileSearch}
                      onQueryChange={setStashFileSearch}
                      placeholder={t('review.searchFiles', 'Filter files…')}
                      totalMatches={stashTreeFiles.length}
                      resultLabel={
                        stashFileSearch ? `${stashTreeFiles.length}/${stashFiles.length}` : ''
                      }
                      caseSensitive={stashFileSearchCaseSensitive}
                      onCaseSensitiveChange={setStashFileSearchCaseSensitive}
                      onClose={stashFileSearch ? () => setStashFileSearch('') : undefined}
                      autoFocus={false}
                      testIdPrefix="stash-detail-file-filter"
                    />
                  </div>
                )}
                <ScrollArea className="min-h-0 flex-1">
                  {stashFiles.length === 0 ? (
                    <EmptyState fill={false} title={t('review.noFiles', 'No files')} />
                  ) : stashTreeFiles.length === 0 ? (
                    <EmptyState
                      fill={false}
                      title={t('history.noMatchingFiles', 'No matching files')}
                    />
                  ) : (
                    <FileTree
                      files={stashTreeFiles}
                      selectedFile={stashDialogFile}
                      onFileClick={(p) =>
                        selectedStashIndex && loadStashFileDiff(selectedStashIndex, p)
                      }
                      testIdPrefix="stash-detail"
                      searchQuery={stashFileSearch || undefined}
                    />
                  )}
                </ScrollArea>
              </div>

              <div className="flex min-w-0 flex-1 flex-col" data-testid="stash-detail-diff-pane">
                {!stashDialogFile ? (
                  <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2">
                    <FileCode className="size-8 opacity-30" />
                    <p className="text-xs">
                      {t('history.selectFile', 'Select a file to view changes')}
                    </p>
                  </div>
                ) : (
                  <ExpandedDiffView
                    filePath={stashDialogFile}
                    oldValue={stashDialogDiff ? parseDiffOld(stashDialogDiff) : ''}
                    newValue={stashDialogDiff ? parseDiffNew(stashDialogDiff) : ''}
                    loading={stashDialogDiffLoading}
                    rawDiff={stashDialogDiff ?? undefined}
                    files={stashTreeFiles}
                    onFileSelect={(p) =>
                      selectedStashIndex && loadStashFileDiff(selectedStashIndex, p)
                    }
                    diffCache={stashDialogDiffCache}
                  />
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Refresh first, then the stash count at the right end. */
function StashToolbar({
  loading,
  count,
  onRefresh,
}: {
  loading: boolean;
  count: number;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  return (
    <TabToolbar data-testid="stash-toolbar">
      <TabToolbarRefresh loading={loading} onRefresh={onRefresh} data-testid="stash-refresh" />
      <TabToolbarSpacer />
      <ToolbarCount label={t('review.toolbarCount.stashes', { count })} testId="stash-count" />
    </TabToolbar>
  );
}

/** The stash message without git's "On <branch>:" / "WIP on <branch>:" prefix: the row shows the branch itself. */
function stashTitle(message: string): string {
  return message.replace(/^(?:WIP )?[Oo]n [^:]+:\s*/, '') || message;
}

/**
 * One stash in the list: opens its detail; pop (latest only, and only on the
 * branch it was made on) and drop appear on hover.
 */
function StashRow({
  entry,
  branch,
  current = false,
  otherBranch,
  now,
  isAgentRunning,
  stashPopInProgress,
  stashDropInProgress,
  onSelect,
  onPop,
  onRequestDrop,
}: {
  entry: UseStashStateResult['filteredStashEntries'][number];
  /** The branch the stash was made on (shown on the row). */
  branch?: string;
  /** The stash was made on the checked-out branch: its branch chip is outlined. */
  current?: boolean;
  /** Set when the stash was made on another branch: popping it here is refused. */
  otherBranch?: string;
  now: number;
  isAgentRunning: boolean;
  stashPopInProgress: UseStashStateResult['stashPopInProgress'];
  stashDropInProgress: UseStashStateResult['stashDropInProgress'];
  onSelect: (idx: string) => void;
  onPop: () => void;
  onRequestDrop: (idx: string) => void;
}) {
  const { t } = useTranslation();
  const idx = entry.index.replace('stash@{', '').replace('}', '');
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(listRowClassName, 'cursor-pointer text-left')}
      onClick={() => onSelect(idx)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(idx);
        }
      }}
      data-testid={`stash-entry-${idx}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={cn(listRowTitleClassName, 'line-clamp-2 break-words')}>
          {stashTitle(entry.message)}
        </span>
        <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
          {branch && (
            <BranchBadge
              branch={branch}
              size="xs"
              highlighted={current}
              highlightLabel={t('review.stashCurrentBranch', 'Current')}
              data-testid={`stash-branch-${idx}`}
            />
          )}
          <span className="shrink-0">{timeAgo(entry.createdAt, t, now)}</span>
        </div>
      </div>
      <ButtonGroup data-testid={`stash-actions-${idx}`}>
        <StashPopButton
          idx={idx}
          otherBranch={otherBranch}
          busy={stashPopInProgress}
          disabled={stashPopInProgress || isAgentRunning}
          onPop={onPop}
        />
        <StashDropButton
          idx={idx}
          dropping={stashDropInProgress === idx}
          disabled={!!stashDropInProgress || isAgentRunning}
          onRequestDrop={onRequestDrop}
        />
      </ButtonGroup>
    </div>
  );
}

/** Pop the stash back into the working tree; only the latest (`stash@{0}`) can be popped. */
function StashPopButton({
  idx,
  otherBranch,
  busy,
  disabled,
  onPop,
}: {
  idx: string;
  otherBranch?: string;
  busy: boolean;
  disabled: boolean;
  onPop: () => void;
}) {
  const { t } = useTranslation();
  // A stash that cannot be popped here (made on another branch, or not the
  // latest) keeps the row's icon color and stays hoverable, so its tooltip can
  // say why; `aria-disabled` blocks the click. A real `disabled` would dim it
  // and, through `pointer-events-none`, hide that tooltip.
  const blocked = !!otherBranch || idx !== '0';
  const label = otherBranch
    ? t('review.popStashOtherBranch', {
        branch: otherBranch,
        defaultValue: `Made on ${otherBranch}: switch to that branch to pop it`,
      })
    : idx === '0'
      ? t('review.popStash', 'Pop stash')
      : t('review.popStashOnlyLatest', 'Only the latest stash can be popped');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          // oxlint-disable-next-line shadcn/require-static-classes -- listRowActionClassName is a static constant from list-row-styles
          className={cn(listRowActionClassName, busy && idx === '0' && listRowActionBusyClassName)}
          onClick={(e) => {
            e.stopPropagation();
            if (!blocked) onPop();
          }}
          disabled={disabled}
          aria-disabled={blocked || undefined}
          data-testid={`stash-pop-${idx}`}
        >
          {busy && idx === '0' ? (
            <Loader2 className="icon-sm animate-spin" />
          ) : (
            <ArchiveRestore className="icon-sm" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Ask to discard the stash (the caller confirms). */
function StashDropButton({
  idx,
  dropping,
  disabled,
  onRequestDrop,
}: {
  idx: string;
  dropping: boolean;
  disabled: boolean;
  onRequestDrop: (idx: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t('review.dropStash', 'Discard stash')}
          // oxlint-disable shadcn/require-static-classes -- listRowActionClassName and listRowActionBusyClassName are static constants from list-row-styles
          className={cn(
            listRowActionClassName,
            'hover:text-destructive',
            dropping && listRowActionBusyClassName,
          )}
          // oxlint-enable shadcn/require-static-classes
          onClick={(e) => {
            e.stopPropagation();
            onRequestDrop(idx);
          }}
          disabled={disabled}
          data-testid={`stash-drop-${idx}`}
        >
          {dropping ? <Loader2 className="icon-sm animate-spin" /> : <Trash2 className="icon-sm" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{t('review.dropStash', 'Discard stash')}</TooltipContent>
    </Tooltip>
  );
}
