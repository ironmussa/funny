import type { FileDiffSummary, PRReviewThread } from '@funny/shared';
import {
  Columns3,
  Columns2,
  FileCode,
  FileText,
  Loader2,
  MessageSquare,
  Rows2,
  WrapText,
  X,
} from 'lucide-react';
import {
  type ComponentType,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useTransition,
} from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FileExtensionIcon } from '@/lib/file-icons';
import { cn } from '@/lib/utils';

import { DiffCommentThread } from '../DiffCommentThread';
import { FileTree } from '../FileTree';
import { type DiffViewMode, VirtualDiff } from '../VirtualDiff';
import { getFileName } from './utils';

/* ── Helpers ── */

/**
 * Compute a minimal unified diff from old/new strings.
 * Used when we only have tool call old_string/new_string (no raw git diff).
 */
function computeUnifiedDiff(oldValue: string, newValue: string): string {
  const oldLines = oldValue.split('\n');
  const newLines = newValue.split('\n');
  const lines: string[] = [];

  lines.push(`--- a/file`);
  lines.push(`+++ b/file`);

  // Simple diff: show all removals then all additions
  // For a more accurate diff, we'd use an LCS algorithm, but this is sufficient
  // for the inline edit card use case where changes are small and localized.
  // We use a basic approach: find common prefix/suffix, diff the middle.
  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const oldChanged = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const newChanged = newLines.slice(prefixLen, newLines.length - suffixLen);

  // Context lines before change
  const ctxBefore = Math.min(prefixLen, 3);
  const ctxAfter = Math.min(suffixLen, 3);

  const hunkOldStart = prefixLen - ctxBefore + 1;
  const hunkNewStart = prefixLen - ctxBefore + 1;
  const hunkOldLen = ctxBefore + oldChanged.length + ctxAfter;
  const hunkNewLen = ctxBefore + newChanged.length + ctxAfter;

  lines.push(`@@ -${hunkOldStart},${hunkOldLen} +${hunkNewStart},${hunkNewLen} @@`);

  // Context before
  for (let i = prefixLen - ctxBefore; i < prefixLen; i++) {
    lines.push(` ${oldLines[i]}`);
  }

  // Removals
  for (const l of oldChanged) lines.push(`-${l}`);
  // Additions
  for (const l of newChanged) lines.push(`+${l}`);

  // Context after
  for (let i = oldLines.length - suffixLen; i < oldLines.length - suffixLen + ctxAfter; i++) {
    lines.push(` ${oldLines[i]}`);
  }

  return lines.join('\n');
}

/* ── Props ── */

interface ExpandedDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  oldValue: string;
  newValue: string;
  icon?: ComponentType<{ className?: string }>;
  loading?: boolean;
  description?: string;
  files?: FileDiffSummary[];
  onFileSelect?: (filePath: string) => void;
  diffCache?: Map<string, string>;
  loadingDiffPath?: string | null;
  checkedFiles?: Set<string>;
  onToggleFile?: (path: string) => void;
  onRevertFile?: (path: string) => void;
  onIgnore?: (pattern: string) => void;
  basePath?: string;
  prReviewThreads?: PRReviewThread[];
  onRequestFullDiff?: (
    filePath: string,
  ) => Promise<{ oldValue: string; newValue: string; rawDiff?: string } | null>;
}

/* ── Diff content ── */

function DiffContent({
  filePath,
  splitView,
  viewMode,
  loading,
  rawDiff,
  oldValue,
  newValue,
  showFullFile,
  wordWrap,
}: {
  filePath: string;
  /** @deprecated Use viewMode instead */
  splitView: boolean;
  viewMode?: DiffViewMode;
  loading: boolean;
  rawDiff?: string;
  oldValue: string;
  newValue: string;
  /** When true, disable code folding so the entire file is visible */
  showFullFile?: boolean;
  wordWrap?: boolean;
}) {
  // Compute unified diff from old/new if rawDiff is not provided
  const unifiedDiff = useMemo(() => {
    if (rawDiff) return rawDiff;
    if (!oldValue && !newValue) return '';
    return computeUnifiedDiff(oldValue, newValue);
  }, [rawDiff, oldValue, newValue]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
        <Loader2 className="icon-base animate-spin" />
        Loading diff…
      </div>
    );
  }

  if (!unifiedDiff) {
    return <p className="p-4 text-xs text-muted-foreground">No diff available</p>;
  }

  return (
    <VirtualDiff
      unifiedDiff={unifiedDiff}
      viewMode={viewMode}
      splitView={splitView}
      filePath={filePath}
      codeFolding={!showFullFile}
      showMinimap={!!showFullFile}
      wordWrap={wordWrap}
      className="h-full"
      data-testid="expanded-diff-viewer"
    />
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
  diffCache,
  checkedFiles,
  onToggleFile,
  onRevertFile,
  onIgnore,
  basePath,
  prReviewThreads,
  onRequestFullDiff,
}: ExpandedDiffDialogProps) {
  const [viewMode, setViewMode] = useState<DiffViewMode>('three-pane');
  const [wordWrap, setWordWrap] = useState(false);
  const [showFullFile, setShowFullFile] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [fullDiffCache, setFullDiffCache] = useState<
    Map<string, { oldValue: string; newValue: string; rawDiff?: string }>
  >(new Map());
  const [loadingFullDiff, setLoadingFullDiff] = useState(false);

  const VIEW_MODE_CYCLE: DiffViewMode[] = ['unified', 'split', 'three-pane'];
  const cycleViewMode = useCallback(() => {
    startTransition(() => {
      setViewMode((prev) => {
        const idx = VIEW_MODE_CYCLE.indexOf(prev);
        return VIEW_MODE_CYCLE[(idx + 1) % VIEW_MODE_CYCLE.length];
      });
    });
  }, []);

  const toggleFullFile = useCallback(async () => {
    if (showFullFile) {
      startTransition(() => setShowFullFile(false));
      return;
    }
    if (fullDiffCache.has(filePath)) {
      startTransition(() => setShowFullFile(true));
      return;
    }
    if (!onRequestFullDiff) {
      startTransition(() => setShowFullFile(true));
      return;
    }
    setLoadingFullDiff(true);
    const result = await onRequestFullDiff(filePath);
    setLoadingFullDiff(false);
    if (result) {
      setFullDiffCache((prev) => new Map(prev).set(filePath, result));
      startTransition(() => setShowFullFile(true));
    }
  }, [showFullFile, filePath, fullDiffCache, onRequestFullDiff]);

  // ── Multi-tab state ──
  const [openTabs, setOpenTabs] = useState<string[]>([filePath]);
  const activeTab = filePath;

  useEffect(() => {
    setOpenTabs((prev) => (prev.includes(filePath) ? prev : [...prev, filePath]));
    if (showFullFile && !fullDiffCache.has(filePath)) {
      setShowFullFile(false);
    }
  }, [filePath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) setOpenTabs([]);
  }, [open]);

  const handleTabClick = useCallback(
    (path: string) => {
      onFileSelect?.(path);
    },
    [onFileSelect],
  );

  const handleTabClose = useCallback(
    (path: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setOpenTabs((prev) => {
        const next = prev.filter((p) => p !== path);
        if (next.length === 0) {
          onOpenChange(false);
          return prev;
        }
        if (path === filePath) {
          const idx = prev.indexOf(path);
          const newActive = next[Math.min(idx, next.length - 1)];
          onFileSelect?.(newActive);
        }
        return next;
      });
    },
    [filePath, onFileSelect, onOpenChange],
  );

  const fileThreads = useMemo(
    () => (prReviewThreads ?? []).filter((t) => t.path === filePath),
    [prReviewThreads, filePath],
  );

  const hasFileSidebar = files && files.length > 0 && onFileSelect;
  const hasMultipleTabs = openTabs.length > 1;

  const handleFileClick = useCallback(
    (path: string) => {
      setOpenTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
      onFileSelect?.(path);
    },
    [onFileSelect],
  );

  // Determine which raw diff / old/new values to pass
  const effectiveRawDiff =
    showFullFile && fullDiffCache.has(filePath)
      ? fullDiffCache.get(filePath)!.rawDiff
      : diffCache?.get(filePath);
  const effectiveOldValue =
    showFullFile && fullDiffCache.has(filePath) ? fullDiffCache.get(filePath)!.oldValue : oldValue;
  const effectiveNewValue =
    showFullFile && fullDiffCache.has(filePath) ? fullDiffCache.get(filePath)!.newValue : newValue;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85vh] w-[90vw] max-w-[90vw] flex-col gap-0 p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex-shrink-0 overflow-hidden border-b border-border px-4 py-3">
          <DialogTitle className="flex min-w-0 items-center gap-2 overflow-hidden font-mono text-sm">
            <Icon className="icon-base flex-shrink-0" />
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
                onClick={cycleViewMode}
                disabled={isPending}
                className="flex-shrink-0 text-muted-foreground"
                data-testid="diff-toggle-view-mode"
              >
                {isPending ? (
                  <Loader2 className="icon-base animate-spin" />
                ) : viewMode === 'unified' ? (
                  <Rows2 className="icon-base" />
                ) : viewMode === 'split' ? (
                  <Columns2 className="icon-base" />
                ) : (
                  <Columns3 className="icon-base" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {viewMode === 'three-pane'
                ? 'Three-pane — click for split'
                : viewMode === 'split'
                  ? 'Split — click for unified'
                  : 'Unified — click for three-pane'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setWordWrap((w) => !w)}
                className={cn(
                  'flex-shrink-0 text-muted-foreground',
                  wordWrap && 'bg-accent text-accent-foreground',
                )}
                data-testid="diff-toggle-word-wrap"
              >
                <WrapText className="icon-base" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {wordWrap ? 'Word wrap on' : 'Word wrap off'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={toggleFullFile}
                disabled={isPending || loadingFullDiff}
                className={cn(
                  'flex-shrink-0 text-muted-foreground',
                  showFullFile && 'bg-accent text-accent-foreground',
                )}
                data-testid="diff-toggle-full-file"
              >
                {isPending || loadingFullDiff ? (
                  <Loader2 className="icon-base animate-spin" />
                ) : (
                  <FileText className="icon-base" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {showFullFile ? 'Show changes only' : 'Show full file'}
            </TooltipContent>
          </Tooltip>
          <DialogDescription className="sr-only">
            {description || `Diff for ${getFileName(filePath)}`}
          </DialogDescription>
        </DialogHeader>

        {/* Multi-tab bar */}
        {hasMultipleTabs && (
          <div
            className="flex items-center overflow-x-auto border-b border-border bg-muted/30"
            data-testid="diff-tab-bar"
          >
            {openTabs.map((tabPath) => (
              <div
                key={tabPath}
                className={cn(
                  'group flex items-center gap-1.5 border-r border-border px-3 py-1.5 text-[11px] cursor-pointer shrink-0',
                  activeTab === tabPath
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground hover:bg-muted/50',
                )}
                onClick={() => handleTabClick(tabPath)}
                data-testid={`diff-tab-${getFileName(tabPath)}`}
              >
                <FileExtensionIcon filePath={tabPath} className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-[120px] truncate">{getFileName(tabPath)}</span>
                <button
                  onClick={(e) => handleTabClose(tabPath, e)}
                  className="ml-0.5 rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
                  data-testid={`diff-tab-close-${getFileName(tabPath)}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* File tree sidebar */}
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

          {/* Diff content + review threads */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-auto">
              <DiffContent
                filePath={filePath}
                splitView={viewMode === 'split'}
                viewMode={viewMode}
                loading={loading || loadingFullDiff}
                rawDiff={effectiveRawDiff}
                oldValue={effectiveOldValue}
                newValue={effectiveNewValue}
                showFullFile={showFullFile}
                wordWrap={wordWrap}
              />
            </div>
            {/* Inline PR review threads */}
            {fileThreads.length > 0 && (
              <div
                className="border-t border-border bg-muted/20 px-4 py-3"
                data-testid="diff-review-threads"
              >
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <MessageSquare className="h-3.5 w-3.5" />
                  {fileThreads.length} review {fileThreads.length === 1 ? 'thread' : 'threads'}
                </div>
                <div className="space-y-2">
                  {fileThreads.map((thread) => (
                    <DiffCommentThread
                      key={thread.id}
                      thread={thread}
                      className="w-full max-w-none"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
