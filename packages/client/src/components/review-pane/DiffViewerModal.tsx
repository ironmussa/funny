import type { FileDiffSummary, PRReviewThread } from '@funny/shared';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';

import { FileTree } from '@/components/FileTree';
import { ExpandedDiffView } from '@/components/tool-cards/ExpandedDiffDialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';

interface DiffViewerModalProps {
  // Which file is open (null = closed)
  expandedFile: string | null;
  expandedSummary: FileDiffSummary | undefined;
  expandedDiffContent: string | undefined;
  ExpandedIcon: ComponentType<{ className?: string }>;
  onClose: () => void;
  onFileSelect: (path: string) => void;

  // File-tree sidebar state
  fileSearch: string;
  setFileSearch: (q: string) => void;
  fileSearchCaseSensitive: boolean;
  setFileSearchCaseSensitive: (b: boolean) => void;
  filteredDiffs: FileDiffSummary[];
  summaries: FileDiffSummary[];
  checkedFiles: Set<string>;
  toggleFile: (path: string) => void;
  onRevertFile: (path: string) => void;
  onIgnore: (pattern: string) => void;
  basePath: string | undefined;

  // Diff view callbacks + state
  loadingDiff: string | null;
  diffCache: Map<string, string>;
  prThreads: PRReviewThread[] | undefined;
  requestFullDiff: (
    filePath: string,
  ) => Promise<{ oldValue: string; newValue: string; rawDiff?: string } | null>;
  handleResolveConflict: (blockId: number, resolution: 'ours' | 'theirs' | 'both') => Promise<void>;
  handleStagePatch: (patch: string) => Promise<void>;
  patchStagingInProgress: boolean;
  handleSelectionStateChange: (filePath: string, state: 'all' | 'partial' | 'none') => void;
  selectAllSignal: number;
  deselectAllSignal: number;
}

/**
 * Centered Dialog overlay that shows the expanded diff for a single file
 * with a file-tree sidebar for navigation. Mirrors the commit-detail dialog.
 *
 * Extracted from ReviewPane.tsx as part of the god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
export function DiffViewerModal({
  expandedFile,
  expandedSummary,
  expandedDiffContent,
  ExpandedIcon,
  onClose,
  onFileSelect,
  fileSearch,
  setFileSearch,
  fileSearchCaseSensitive,
  setFileSearchCaseSensitive,
  filteredDiffs,
  summaries,
  checkedFiles,
  toggleFile,
  onRevertFile,
  onIgnore,
  basePath,
  loadingDiff,
  diffCache,
  prThreads,
  requestFullDiff,
  handleResolveConflict,
  handleStagePatch,
  patchStagingInProgress,
  handleSelectionStateChange,
  selectAllSignal,
  deselectAllSignal,
}: DiffViewerModalProps) {
  const { t } = useTranslation();

  return (
    <Dialog
      open={!!expandedFile}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex h-[85vh] max-w-[90vw] flex-col gap-0 p-0"
        data-testid="expanded-diff-overlay"
      >
        <DialogTitle className="sr-only">
          {expandedSummary?.path ?? t('review.diffViewer', 'Diff viewer')}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t('review.diffViewerDescription', 'View and stage changes for the selected file')}
        </DialogDescription>
        {expandedFile && (
          <div className="flex min-h-0 flex-1">
            {/* File tree sidebar */}
            <div
              className="flex w-[280px] shrink-0 flex-col border-r border-border"
              data-testid="expanded-diff-file-tree"
            >
              <div className="shrink-0 border-b border-sidebar-border px-2 py-1">
                <SearchBar
                  query={fileSearch}
                  onQueryChange={setFileSearch}
                  placeholder={t('review.searchFiles', 'Filter files…')}
                  totalMatches={filteredDiffs.length}
                  resultLabel={fileSearch ? `${filteredDiffs.length}/${summaries.length}` : ''}
                  caseSensitive={fileSearchCaseSensitive}
                  onCaseSensitiveChange={setFileSearchCaseSensitive}
                  onClose={fileSearch ? () => setFileSearch('') : undefined}
                  autoFocus={false}
                  testIdPrefix="expanded-diff-file-filter"
                />
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <FileTree
                  files={filteredDiffs}
                  selectedFile={expandedFile}
                  onFileClick={onFileSelect}
                  checkedFiles={checkedFiles}
                  onToggleFile={toggleFile}
                  onRevertFile={onRevertFile}
                  onIgnore={onIgnore}
                  basePath={basePath}
                  searchQuery={fileSearch || undefined}
                  testIdPrefix="expanded-diff"
                />
              </ScrollArea>
            </div>

            {/* Diff viewer */}
            <div className="flex min-w-0 flex-1 flex-col">
              <ExpandedDiffView
                filePath={expandedSummary?.path || ''}
                oldValue={expandedDiffContent ? parseDiffOld(expandedDiffContent) : ''}
                newValue={expandedDiffContent ? parseDiffNew(expandedDiffContent) : ''}
                icon={ExpandedIcon}
                loading={loadingDiff === expandedFile}
                rawDiff={expandedDiffContent}
                diffCache={diffCache}
                onClose={onClose}
                prReviewThreads={prThreads}
                onRequestFullDiff={requestFullDiff}
                onResolveConflict={handleResolveConflict}
                selectable
                onStagePatch={handleStagePatch}
                stagingInProgress={patchStagingInProgress}
                onSelectionStateChange={handleSelectionStateChange}
                selectAllSignal={selectAllSignal}
                deselectAllSignal={deselectAllSignal}
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
