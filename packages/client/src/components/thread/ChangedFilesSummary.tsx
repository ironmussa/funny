import type { FileDiffSummary } from '@funny/shared';
import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { DiffStats } from '@/components/DiffStats';
import { ExpandedDiffDialog } from '@/components/tool-cards/ExpandedDiffDialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { parseDiffNew, parseDiffOld } from '@/lib/diff-parse';
import { cn } from '@/lib/utils';

/**
 * Compact summary of the files modified during one session (user turn → agent
 * run). Rendered at the end of each session in the message stream so the user
 * can scroll up and see what changed where. Opens the same single-file diff
 * popup the thread's Edit/Write tool cards use on file click (no file explorer
 * sidebar), and offers a one-click Undo that reverts that session's files.
 */
export function ChangedFilesSummary({
  threadId,
  files,
  running = false,
  onReverted,
  fallbackDiffs,
}: {
  threadId: string;
  /** The files changed in this session (already resolved to working-tree diff stats). */
  files: FileDiffSummary[];
  /** While the agent is running, revert actions are disabled to avoid racing live edits. */
  running?: boolean;
  /** Called after a successful revert so the diff data can refetch. */
  onReverted?: () => void;
  /** Per-session tool-call diffs used when the live working-tree diff is empty. */
  fallbackDiffs?: Map<string, string>;
}) {
  const { t } = useTranslation();
  const [reverting, setReverting] = useState(false);

  // ── Diff popup state — same single-file dialog the Edit/Write tool cards use ──
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diffCache, setDiffCache] = useState<Map<string, string>>(new Map());
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      additions += f.additions ?? 0;
      deletions += f.deletions ?? 0;
    }
    return { additions, deletions };
  }, [files]);

  const loadDiffForFile = useCallback(
    async (filePath: string) => {
      if (!threadId || diffCache.has(filePath)) return;
      const summary = files.find((s) => s.path === filePath);
      if (!summary) return;
      setLoadingDiff(filePath);
      const result = await api.getFileDiff(threadId, filePath, summary.staged);
      if (result.isOk()) {
        const diff = result.value.diff || fallbackDiffs?.get(filePath) || '';
        setDiffCache((prev) => new Map(prev).set(filePath, diff));
      } else if (fallbackDiffs?.has(filePath)) {
        setDiffCache((prev) => new Map(prev).set(filePath, fallbackDiffs.get(filePath)!));
      }
      setLoadingDiff((prev) => (prev === filePath ? null : prev));
    },
    [threadId, diffCache, files, fallbackDiffs],
  );

  useEffect(() => {
    if (expandedFile && !diffCache.has(expandedFile)) {
      loadDiffForFile(expandedFile);
    }
  }, [diffCache, expandedFile, loadDiffForFile]);

  const requestFullDiff = useCallback(
    async (
      path: string,
    ): Promise<{ oldValue: string; newValue: string; rawDiff?: string } | null> => {
      if (!threadId) return null;
      const summary = files.find((s) => s.path === path);
      if (!summary) return null;
      const result = await api.getFileDiff(threadId, path, summary.staged, undefined, 'full');
      const diff = result.isOk()
        ? result.value.diff || fallbackDiffs?.get(path)
        : fallbackDiffs?.get(path);
      if (diff) {
        return {
          oldValue: parseDiffOld(diff),
          newValue: parseDiffNew(diff),
          rawDiff: diff,
        };
      }
      return null;
    },
    [threadId, files, fallbackDiffs],
  );

  if (files.length === 0) return null;

  const handleUndoAll = async () => {
    setReverting(true);
    const result = await api.revertFiles(
      threadId,
      files.map((f) => f.path),
    );
    setReverting(false);
    if (result.isErr()) {
      toast.error(t('review.revertFailed', { message: result.error.message }));
    } else {
      toast.success(
        t('thread.changedFilesReverted', {
          count: files.length,
          defaultValue: '{{count}} files reverted',
        }),
      );
      onReverted?.();
    }
  };

  const expandedDiffContent = expandedFile ? diffCache.get(expandedFile) : undefined;

  return (
    <div
      data-testid="changed-files-summary"
      className="border-border bg-muted/30 flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-xs"
    >
      {/* Header: "N files changed +A -D" + Undo */}
      <div className="flex items-center gap-2">
        <span className="text-foreground font-medium">
          {t('thread.changedFilesCount', {
            count: files.length,
            defaultValue: '{{count}} files changed',
          })}
        </span>
        <DiffStats
          linesAdded={totals.additions}
          linesDeleted={totals.deletions}
          size="xs"
          tooltips={false}
        />
        <Button
          variant="ghost"
          size="xs"
          onClick={handleUndoAll}
          disabled={reverting || running}
          className="text-muted-foreground hover:text-foreground ml-auto gap-1"
          data-testid="changed-files-undo"
        >
          <RotateCcw className={cn('icon-xs', reverting && 'animate-spin')} />
          {t('thread.changedFilesUndo', 'Undo')}
        </Button>
      </div>

      {/* Per-file rows — click a name to open the thread's diff popup */}
      <div className="flex flex-col gap-0.5">
        {files.map((f) => (
          <div
            key={f.path}
            data-testid={`changed-files-row-${f.path}`}
            // min-h keeps every row the same height even when DiffStats renders
            // nothing (stat-less files), so the list doesn't get uneven spacing.
            className="flex min-h-6 items-center gap-2"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setExpandedFile(f.path)}
                  className="text-muted-foreground hover:text-foreground min-w-0 flex-1 truncate text-left font-mono transition-colors hover:underline"
                  data-testid={`changed-files-open-${f.path}`}
                >
                  {f.path}
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[min(32rem,calc(100vw-2rem))] font-mono break-all">
                {f.path}
              </TooltipContent>
            </Tooltip>
            <DiffStats
              linesAdded={f.additions ?? 0}
              linesDeleted={f.deletions ?? 0}
              size="xs"
              tooltips={false}
            />
          </div>
        ))}
      </div>

      {/* Diff popup — the exact single-file dialog the Edit/Write tool cards open
          (no file explorer sidebar): pass neither `files` nor `onFileSelect`. */}
      <ExpandedDiffDialog
        open={!!expandedFile}
        onOpenChange={(open) => {
          if (!open) setExpandedFile(null);
        }}
        filePath={expandedFile ?? ''}
        oldValue={expandedDiffContent ? parseDiffOld(expandedDiffContent) : ''}
        newValue={expandedDiffContent ? parseDiffNew(expandedDiffContent) : ''}
        loading={loadingDiff === expandedFile}
        diffCache={diffCache}
        onRequestFullDiff={requestFullDiff}
      />
    </div>
  );
}
