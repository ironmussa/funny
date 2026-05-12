import { Archive, ArchiveRestore, FileCode, Loader2, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { FileTree } from '@/components/FileTree';
import { ExpandedDiffView } from '@/components/tool-cards/ExpandedDiffDialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
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

  return (
    <>
      <ScrollArea className="flex min-h-0 flex-1 flex-col">
        {filteredStashEntries.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
            <Archive className="size-8 opacity-40" />
            <p className="text-xs">
              {currentBranch
                ? t('review.noStashesOnBranch', {
                    branch: currentBranch,
                    defaultValue: `No stashed changes on ${currentBranch}`,
                  })
                : t('review.noStashes', 'No stashed changes')}
            </p>
            {stashEntries.length > 0 && (
              <p className="text-[10px] opacity-60">
                {t('review.stashesOnOtherBranches', {
                  count: stashEntries.length,
                  defaultValue: `${stashEntries.length} stash(es) on other branches`,
                })}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-sidebar-border">
            {filteredStashEntries.map((entry) => {
              const idx = entry.index.replace('stash@{', '').replace('}', '');
              return (
                <div
                  key={entry.index}
                  role="button"
                  tabIndex={0}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-sidebar-accent/50"
                  onClick={() => setSelectedStashIndex(idx)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedStashIndex(idx);
                    }
                  }}
                  data-testid={`stash-entry-${idx}`}
                >
                  <Archive className="size-3 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{entry.message}</span>
                    <span className="text-[10px] text-muted-foreground">{entry.relativeDate}</span>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 text-muted-foreground"
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
                        className="shrink-0 text-muted-foreground hover:text-destructive"
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
          <div className="shrink-0 border-b border-border px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <DialogTitle className="text-sm font-semibold leading-tight">
                {selectedStashEntry?.message ?? t('review.stashDetails', 'Stash details')}
              </DialogTitle>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setSelectedStashIndex(null)}
                className="shrink-0 text-muted-foreground"
                data-testid="stash-detail-close"
              >
                <X className="icon-xs" />
              </Button>
            </div>
            <DialogDescription className="sr-only">
              {t('review.stashDetailsDesc', 'Stash detail with file changes and diffs')}
            </DialogDescription>
            {selectedStashEntry && (
              <div className="flex items-center gap-1.5 pt-1 text-[11px] text-muted-foreground">
                <Archive className="icon-xs flex-shrink-0" />
                <code className="flex-shrink-0 font-mono text-primary">
                  {selectedStashEntry.index}
                </code>
                <span className="flex-shrink-0">{selectedStashEntry.relativeDate}</span>
                <span className="flex-shrink-0 text-muted-foreground">
                  &middot; {stashFiles.length} file{stashFiles.length !== 1 ? 's' : ''}
                </span>
              </div>
            )}
          </div>

          {stashFilesLoading ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t('review.loading', 'Loading changes…')}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <div
                className="flex w-[280px] shrink-0 flex-col border-r border-border"
                data-testid="stash-detail-file-tree"
              >
                {stashFiles.length > 0 && (
                  <div className="shrink-0 border-b border-sidebar-border px-2 py-1">
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
                    <div className="py-4 text-center text-xs text-muted-foreground">
                      {t('review.noFiles', 'No files')}
                    </div>
                  ) : stashTreeFiles.length === 0 ? (
                    <div className="py-4 text-center text-xs text-muted-foreground">
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
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
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
