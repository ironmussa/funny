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
import type { UseStashStateResult } from '@/hooks/use-stash-state';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';

interface StashTabProps {
  stash: UseStashStateResult;
  currentBranch: string | undefined;
  isAgentRunning: boolean;
  /** Caller opens its confirm dialog; the drop is executed via stash.executeStashDrop. */
  onRequestDrop: (stashIndex: string) => void;
}

export function StashTab({ stash, currentBranch, isAgentRunning, onRequestDrop }: StashTabProps) {
  const { t } = useTranslation();
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
          {filteredStashEntries.map((entry) => {
            const idx = entry.index.replace('stash@{', '').replace('}', '');
            return (
              <div
                key={entry.index}
                role="button"
                tabIndex={0}
                className="hover:bg-sidebar-accent/50 flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs transition-colors"
                onClick={() => setSelectedStashIndex(idx)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedStashIndex(idx);
                  }
                }}
                data-testid={`stash-entry-${idx}`}
              >
                <Archive className="text-muted-foreground size-3 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{entry.message}</span>
                  <span className="text-muted-foreground text-[10px]">{entry.relativeDate}</span>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleStashPop();
                      }}
                      disabled={stashPopInProgress || !!isAgentRunning || idx !== '0'}
                      data-testid={`stash-pop-${idx}`}
                    >
                      {stashPopInProgress && idx === '0' ? (
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
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground hover:text-destructive shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRequestDrop(idx);
                      }}
                      disabled={!!stashDropInProgress || !!isAgentRunning}
                      data-testid={`stash-drop-${idx}`}
                    >
                      {stashDropInProgress === idx ? (
                        <Loader2 className="icon-sm animate-spin" />
                      ) : (
                        <Trash2 className="icon-sm" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    {t('review.dropStash', 'Discard stash')}
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })}
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
                <span className="shrink-0">{selectedStashEntry.relativeDate}</span>
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
                    <div className="text-muted-foreground py-4 text-center text-xs">
                      {t('review.noFiles', 'No files')}
                    </div>
                  ) : stashTreeFiles.length === 0 ? (
                    <div className="text-muted-foreground py-4 text-center text-xs">
                      {t('history.noMatchingFiles', 'No matching files')}
                    </div>
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
