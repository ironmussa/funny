import {
  Archive,
  ArchiveRestore,
  FileCode,
  GitBranch,
  Loader2,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FileTree } from '@/components/FileTree';
import { ExpandedDiffView } from '@/components/tool-cards/ExpandedDiffDialog';
import { Button } from '@/components/ui/button';
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
  listRowActionClassName,
  listRowClassName,
  listRowTitleClassName,
} from '@/lib/list-row-styles';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

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
        {filteredStashEntries.length > 0 ? (
          <div className="divide-sidebar-border flex flex-col divide-y">
            {filteredStashEntries.map((entry) => (
              <StashRow key={entry.index} entry={entry} {...rowProps} />
            ))}
          </div>
        ) : (
          <EmptyState
            fill={false}
            className="py-6"
            icon={Archive}
            title={noStashesTitle}
            testId="stash-current-branch-empty"
          />
        )}

        {otherBranchStashGroups.length > 0 && (
          <div className="flex flex-col" data-testid="stash-other-branches">
            <div className="text-muted-foreground border-sidebar-border border-y px-3 py-1.5 text-xs font-medium">
              {t('review.stashOtherBranches', 'Other branches')}
            </div>
            {otherBranchStashGroups.map((group) => (
              <div
                key={group.branch}
                className="flex flex-col"
                data-testid={`stash-branch-group-${group.branch}`}
              >
                <div className="text-muted-foreground flex min-w-0 items-center gap-1.5 px-3 pt-2 pb-1 text-xs">
                  <GitBranch className="icon-xs shrink-0" />
                  <span className="truncate font-mono" title={group.branch}>
                    {group.branch}
                  </span>
                  <span className="shrink-0">({group.entries.length})</span>
                </div>
                <div className="divide-sidebar-border flex flex-col divide-y">
                  {group.entries.map((entry) => (
                    <StashRow
                      key={entry.index}
                      entry={entry}
                      otherBranch={group.branch}
                      {...rowProps}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Stash detail dialog */}
      <Dialog
        open={!!selectedStashIndex}
        onOpenChange={(open) => {
          if (!open) setSelectedStashIndex(null);
        }}
      >
        <DialogContent
          className="flex h-[85vh] max-w-[90vw] flex-col gap-0 p-0"
          data-testid="stash-detail-dialog"
        >
          <div className="border-border shrink-0 border-b px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <DialogTitle className="text-sm leading-tight font-semibold">
                {selectedStashEntry?.message ?? t('review.stashDetails', 'Stash details')}
              </DialogTitle>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setSelectedStashIndex(null)}
                className="text-muted-foreground shrink-0"
                data-testid="stash-detail-close"
              >
                <X className="icon-xs" />
              </Button>
            </div>
            <DialogDescription className="sr-only">
              {t('review.stashDetailsDesc', 'Stash detail with file changes and diffs')}
            </DialogDescription>
            {selectedStashEntry && (
              <div className="text-muted-foreground flex items-center gap-1.5 pt-1 text-[11px]">
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
                    <EmptyState
                      fill={false}
                      className="py-4"
                      title={t('review.noFiles', 'No files')}
                    />
                  ) : stashTreeFiles.length === 0 ? (
                    <EmptyState
                      fill={false}
                      className="py-4"
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
    <div className="border-sidebar-border flex shrink-0 items-center gap-1 border-b px-2 py-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            disabled={loading}
            aria-label={t('common.refresh', 'Refresh')}
            className="text-muted-foreground shrink-0"
            data-testid="stash-refresh"
          >
            <RefreshCw className={cn('icon-base', loading && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('common.refresh', 'Refresh')}</TooltipContent>
      </Tooltip>
      <ToolbarCount label={t('review.toolbarCount.stashes', { count })} testId="stash-count" />
    </div>
  );
}

/**
 * One stash in the list: opens its detail; pop (latest only, and only on the
 * branch it was made on) and drop appear on hover.
 */
function StashRow({
  entry,
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
      <Archive className="icon-sm text-muted-foreground mt-0.5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className={cn(listRowTitleClassName, 'line-clamp-2 break-words')}>
          {entry.message}
        </span>
        <span className="text-muted-foreground text-[10px]">
          {timeAgo(entry.createdAt, t, now)}
        </span>
      </div>
      <StashPopButton
        idx={idx}
        otherBranch={otherBranch}
        busy={stashPopInProgress}
        disabled={stashPopInProgress || isAgentRunning || idx !== '0' || !!otherBranch}
        onPop={onPop}
      />
      <StashDropButton
        idx={idx}
        dropping={stashDropInProgress === idx}
        disabled={!!stashDropInProgress || isAgentRunning}
        onRequestDrop={onRequestDrop}
      />
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
          className={cn(listRowActionClassName, busy && idx === '0' && 'opacity-100')}
          onClick={(e) => {
            e.stopPropagation();
            onPop();
          }}
          disabled={disabled}
          data-testid={`stash-pop-${idx}`}
        >
          {busy && idx === '0' ? (
            <Loader2 className="icon-sm animate-spin" />
          ) : (
            <ArchiveRestore className="icon-sm" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
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
          className={cn(
            // oxlint-disable-next-line shadcn/require-static-classes -- listRowActionClassName is a static constant
            listRowActionClassName,
            'hover:text-destructive',
            dropping && 'opacity-100',
          )}
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
      <TooltipContent side="left">{t('review.dropStash', 'Discard stash')}</TooltipContent>
    </Tooltip>
  );
}
