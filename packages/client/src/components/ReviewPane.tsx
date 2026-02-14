import { useState, useEffect, useMemo, memo, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ReactDiffViewer, DIFF_VIEWER_STYLES } from './tool-cards/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import { useAutoRefreshDiff } from '@/hooks/use-auto-refresh-diff';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  RefreshCw,
  Plus,
  Minus,
  Undo2,
  FileCode,
  FilePlus,
  FileX,
  PanelRightClose,
} from 'lucide-react';
import type { FileDiff } from '@a-parallel/shared';

const fileStatusIcons: Record<string, typeof FileCode> = {
  added: FilePlus,
  modified: FileCode,
  deleted: FileX,
  renamed: FileCode,
};

function parseDiffOld(unifiedDiff: string): string {
  const lines = unifiedDiff.split('\n');
  const oldLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
      continue;
    }
    if (line.startsWith('-')) {
      oldLines.push(line.substring(1));
    } else if (!line.startsWith('+')) {
      oldLines.push(line);
    }
  }

  return oldLines.join('\n');
}

function parseDiffNew(unifiedDiff: string): string {
  const lines = unifiedDiff.split('\n');
  const newLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
      continue;
    }
    if (line.startsWith('+')) {
      newLines.push(line.substring(1));
    } else if (!line.startsWith('-')) {
      newLines.push(line);
    }
  }

  return newLines.join('\n');
}

const MemoizedDiffView = memo(function MemoizedDiffView({ diff }: { diff: string }) {
  const oldValue = useMemo(() => parseDiffOld(diff), [diff]);
  const newValue = useMemo(() => parseDiffNew(diff), [diff]);

  return (
    <ReactDiffViewer
      oldValue={oldValue}
      newValue={newValue}
      splitView={false}
      useDarkTheme={true}
      hideLineNumbers={false}
      showDiffOnly={true}
      styles={DIFF_VIEWER_STYLES}
    />
  );
});

export function ReviewPane() {
  const { t } = useTranslation();
  const activeThread = useAppStore(s => s.activeThread);
  const setReviewPaneOpen = useAppStore(s => s.setReviewPaneOpen);
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revertConfirm, setRevertConfirm] = useState<{ paths: string[] } | null>(null);

  const threadId = activeThread?.id;

  const refresh = async () => {
    if (!threadId) return;
    setLoading(true);
    const result = await api.getDiff(threadId);
    if (result.isOk()) {
      const data = result.value;
      setDiffs(data);
      if (data.length > 0 && !selectedFile) {
        setSelectedFile(data[0].path);
      }
    } else {
      console.error('Failed to load diff:', result.error);
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, [threadId]);

  // Auto-refresh diffs when agent modifies files (debounced 2s)
  useAutoRefreshDiff(threadId, refresh, 2000);

  const selectedDiff = diffs.find((d) => d.path === selectedFile);

  const stagedCount = diffs.filter(d => d.staged).length;
  const unstagedCount = diffs.filter(d => !d.staged).length;

  const handleStage = async (paths: string[]) => {
    if (!threadId) return;
    const result = await api.stageFiles(threadId, paths);
    if (result.isErr()) {
      toast.error(t('review.stageFailed', { message: result.error.message }));
      return;
    }
    await refresh();
  };

  const handleUnstage = async (paths: string[]) => {
    if (!threadId) return;
    const result = await api.unstageFiles(threadId, paths);
    if (result.isErr()) {
      toast.error(t('review.unstageFailed', { message: result.error.message }));
      return;
    }
    await refresh();
  };

  const handleRevert = async (paths: string[]) => {
    if (!threadId) return;
    const result = await api.revertFiles(threadId, paths);
    if (result.isErr()) {
      toast.error(t('review.revertFailed', { message: result.error.message }));
      return;
    }
    await refresh();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-sidebar-foreground uppercase tracking-wider">{t('review.title')}</h3>
          {diffs.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-green-400">{stagedCount} staged</span>
              <span className="text-sm text-muted-foreground">|</span>
              <span className="text-sm font-medium text-yellow-400">{unstagedCount} unstaged</span>
            </div>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={refresh}
                className="text-muted-foreground"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('review.refresh')}</TooltipContent>
          </Tooltip>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => setReviewPaneOpen(false)}
              className="text-muted-foreground"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('review.close', 'Close')}</TooltipContent>
        </Tooltip>
      </div>

      {/* File list */}
      <ScrollArea className="border-b border-sidebar-border max-h-48">
        {diffs.length === 0 ? (
          <p className="text-xs text-muted-foreground p-3">{t('review.noChanges')}</p>
        ) : (
          diffs.map((f) => {
            const Icon = fileStatusIcons[f.status] || FileCode;
            return (
              <div
                key={f.path}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-pointer transition-colors',
                  selectedFile === f.path
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'hover:bg-sidebar-accent/50 text-muted-foreground'
                )}
                onClick={() => setSelectedFile(f.path)}
              >
                <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="flex-1 truncate font-mono">{f.path}</span>
                <span className={cn('text-xs', f.staged ? 'text-green-400' : 'text-yellow-400')}>
                  {f.staged ? t('review.staged') : t('review.unstaged')}
                </span>
                <div className="flex gap-0.5">
                  {f.staged ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={(e) => { e.stopPropagation(); handleUnstage([f.path]); }}
                        >
                          <Minus className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">{t('review.unstage')}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={(e) => { e.stopPropagation(); handleStage([f.path]); }}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="top">{t('review.stage')}</TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={(e) => { e.stopPropagation(); setRevertConfirm({ paths: [f.path] }); }}
                        className="text-destructive"
                      >
                        <Undo2 className="h-3 w-3" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{t('review.revert')}</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            );
          })
        )}
      </ScrollArea>

      {/* Diff viewer */}
      <ScrollArea className="flex-1 w-full">
        {selectedDiff ? (
          selectedDiff.diff ? (
            <div className="text-xs [&_.diff-container]:font-mono [&_.diff-container]:text-sm [&_table]:w-max [&_td:last-child]:w-auto [&_td:last-child]:min-w-0">
              <Suspense fallback={<div className="p-2 text-xs text-muted-foreground">Loading diff...</div>}>
                <MemoizedDiffView diff={selectedDiff.diff} />
              </Suspense>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground p-2">{t('review.binaryOrNoDiff')}</p>
          )
        ) : (
          <p className="text-xs text-muted-foreground p-2">{t('review.selectFile')}</p>
        )}
        <ScrollBar orientation="horizontal" />
      </ScrollArea>

      {/* Revert confirmation dialog */}
      <Dialog open={!!revertConfirm} onOpenChange={(open) => { if (!open) setRevertConfirm(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('review.revert')}</DialogTitle>
            <DialogDescription asChild>
              <div>
                <span className="font-mono text-xs">{revertConfirm?.paths.join(', ')}</span>
                <p className="mt-1">{t('review.revertWarning')}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRevertConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => {
              if (revertConfirm) handleRevert(revertConfirm.paths);
              setRevertConfirm(null);
            }}>
              {t('review.revert')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
