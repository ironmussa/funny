import { Archive, ArchiveRestore, FileCode, Loader2, Trash2, X } from 'lucide-react';
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
    handleStashPop,
    loadStashFileDiff,
  } = stash;

  if (filteredStashEntries.length === 0) {
    return (
      <EmptyState
        icon={Archive}
        title={
          currentBranch
            ? t('review.noStashesOnBranch', {
                branch: currentBranch,
                defaultValue: `No stashed changes on ${currentBranch}`,
              })
            : t('review.noStashes', 'No stashed changes')
        }
        description={
          stashEntries.length > 0
            ? t('review.stashesOnOtherBranches', {
                count: stashEntries.length,
                defaultValue: `${stashEntries.length} stash(es) on other branches`,
              })
            : undefined
        }
      />
    );
  }

  return (
    <>
      <ScrollArea className="flex min-h-0 flex-1 flex-col">
        <div className="divide-sidebar-border flex flex-col divide-y">
          {filteredStashEntries.map((entry) => (
            <StashRow
              key={entry.index}
              entry={entry}
              now={now}
              isAgentRunning={isAgentRunning}
              stashPopInProgress={stashPopInProgress}
              stashDropInProgress={stashDropInProgress}
              onSelect={setSelectedStashIndex}
              onPop={handleStashPop}
              onRequestDrop={onRequestDrop}
            />
          ))}
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
    </>
  );
}

/** One stash in the list: opens its detail; pop (latest only) and drop appear on hover. */
function StashRow({
  entry,
  now,
  isAgentRunning,
  stashPopInProgress,
  stashDropInProgress,
  onSelect,
  onPop,
  onRequestDrop,
}: {
  entry: UseStashStateResult['filteredStashEntries'][number];
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
        busy={stashPopInProgress}
        disabled={stashPopInProgress || isAgentRunning || idx !== '0'}
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
  busy,
  disabled,
  onPop,
}: {
  idx: string;
  busy: boolean;
  disabled: boolean;
  onPop: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={
            idx === '0'
              ? t('review.popStash', 'Pop stash')
              : t('review.popStashOnlyLatest', 'Only the latest stash can be popped')
          }
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
      <TooltipContent side="left">
        {idx === '0'
          ? t('review.popStash', 'Pop stash')
          : t('review.popStashOnlyLatest', 'Only the latest stash can be popped')}
      </TooltipContent>
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
