import type { FileDiffSummary } from '@funny/shared';
import { Columns2, FileCode, Loader2, Rows2 } from 'lucide-react';
import { type ComponentType, Suspense, useState, useCallback } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDiffHighlight } from '@/hooks/use-diff-highlight';

import { FileTree } from '../FileTree';
import { ReactDiffViewer, DIFF_VIEWER_STYLES, getFileName } from './utils';

/* ── Props ── */

interface ExpandedDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  oldValue: string;
  newValue: string;
  /** Optional icon override (defaults to FileCode) */
  icon?: ComponentType<{ className?: string }>;
  /** When true, shows a loading spinner instead of the diff */
  loading?: boolean;
  /** Screen-reader description override */
  description?: string;
  /** List of all files in the review pane for sidebar navigation */
  files?: FileDiffSummary[];
  /** Callback when a file is selected from the sidebar */
  onFileSelect?: (filePath: string) => void;
  /** Cache of loaded diffs keyed by file path */
  diffCache?: Map<string, string>;
  /** File path currently being loaded */
  loadingDiffPath?: string | null;
  /** Checked files set (from ReviewPane) */
  checkedFiles?: Set<string>;
  /** Toggle a file's checked state */
  onToggleFile?: (path: string) => void;
  /** Revert a file */
  onRevertFile?: (path: string) => void;
  /** Add a pattern to .gitignore */
  onIgnore?: (pattern: string) => void;
  /** Base path for constructing absolute file paths (for open-in-editor) */
  basePath?: string;
}

/* ── Diff content (extracted to avoid re-highlighting on sidebar interactions) ── */

function DiffContent({
  oldValue,
  newValue,
  filePath,
  splitView,
  loading,
}: {
  oldValue: string;
  newValue: string;
  filePath: string;
  splitView: boolean;
  loading: boolean;
}) {
  const { renderContent } = useDiffHighlight(oldValue, newValue, filePath);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading diff…
      </div>
    );
  }

  if (!oldValue && !newValue) {
    return <p className="p-4 text-xs text-muted-foreground">No diff available</p>;
  }

  return (
    <div className="[&_.diff-container]:font-mono [&_table]:w-full [&_td]:overflow-hidden [&_td]:text-ellipsis">
      <Suspense fallback={<div className="p-4 text-xs text-muted-foreground">Loading diff…</div>}>
        <ReactDiffViewer
          oldValue={oldValue}
          newValue={newValue}
          splitView={splitView}
          useDarkTheme={true}
          hideLineNumbers={false}
          showDiffOnly={true}
          styles={DIFF_VIEWER_STYLES}
          renderContent={renderContent}
        />
      </Suspense>
    </div>
  );
}

/* ── Main component ── */

export function ExpandedDiffDialog({
  open,
  onOpenChange,
  filePath,
  oldValue,
  newValue,
  icon: Icon = FileCode,
  loading = false,
  description,
  files,
  onFileSelect,
  checkedFiles,
  onToggleFile,
  onRevertFile,
  onIgnore,
  basePath,
}: ExpandedDiffDialogProps) {
  const [splitView, setSplitView] = useState(true);

  const hasFileSidebar = files && files.length > 0 && onFileSelect;

  const handleFileClick = useCallback(
    (path: string) => {
      onFileSelect?.(path);
    },
    [onFileSelect],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85vh] w-[90vw] max-w-[90vw] flex-col gap-0 p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex-shrink-0 overflow-hidden border-b border-border px-4 py-3">
          <DialogTitle className="flex min-w-0 items-center gap-2 overflow-hidden font-mono text-sm">
            <Icon className="h-4 w-4 flex-shrink-0" />
            <span
              className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              style={{ direction: 'rtl', textAlign: 'left' }}
            >
              {filePath}
            </span>
          </DialogTitle>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setSplitView((prev) => !prev)}
                className="flex-shrink-0 text-muted-foreground"
                data-testid="diff-toggle-split-view"
              >
                {splitView ? <Rows2 className="h-4 w-4" /> : <Columns2 className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {splitView ? 'Unified view' : 'Split view'}
            </TooltipContent>
          </Tooltip>
          <DialogDescription className="sr-only">
            {description || `Diff for ${getFileName(filePath)}`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          {/* File tree sidebar — shared FileTree component */}
          {hasFileSidebar && (
            <div className="flex w-80 flex-shrink-0 flex-col border-r border-border">
              <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Files
              </div>
              <div className="min-h-0 flex-1">
                <FileTree
                  files={files}
                  selectedFile={filePath}
                  onFileClick={handleFileClick}
                  checkedFiles={checkedFiles}
                  onToggleFile={onToggleFile}
                  onRevertFile={onRevertFile}
                  onIgnore={onIgnore}
                  basePath={basePath}
                  fontSize="text-xs"
                  activeClass="bg-sidebar-accent text-sidebar-accent-foreground"
                  hoverClass="hover:bg-sidebar-accent/50 text-muted-foreground"
                  testIdPrefix="diff-sidebar"
                  virtualize
                />
              </div>
            </div>
          )}

          {/* Diff content */}
          <ScrollArea className="min-h-0 flex-1">
            <DiffContent
              oldValue={oldValue}
              newValue={newValue}
              filePath={filePath}
              splitView={splitView}
              loading={loading}
            />
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
