import type { FileDiffSummary, FileStatus } from '@funny/shared';
import { ChevronRight, FilePen, Maximize2 } from 'lucide-react';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { VirtualDiff } from '@/components/VirtualDiff';
import { api } from '@/lib/api';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';
import { cn } from '@/lib/utils';
import { DIFF_ROW_HEIGHT_PX, useSettingsStore } from '@/stores/settings-store';
import { useThreadId } from '@/stores/thread-context';

import { ExpandedDiffDialog } from './ExpandedDiffDialog';
import {
  toEditorUri,
  openFileInEditor,
  getEditorLabel,
  useCurrentProjectPath,
  makeRelativePath,
} from './utils';

/**
 * Compute a minimal unified diff from old/new strings for inline display.
 *
 * `snippetBaseLine` is the 1-indexed line in the actual file where the
 * snippet begins. Defaults to 1 (snippet-relative numbering) when the real
 * file location isn't yet known.
 */
function computeUnifiedDiff(
  oldValue: string,
  newValue: string,
  snippetBaseLine: number = 1,
): string {
  const oldLines = oldValue.split('\n');
  const newLines = newValue.split('\n');
  const lines: string[] = [];

  lines.push('--- a/file');
  lines.push('+++ b/file');

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

  const ctxBefore = Math.min(prefixLen, 3);
  const ctxAfter = Math.min(suffixLen, 3);
  const hunkOldStart = snippetBaseLine + prefixLen - ctxBefore;
  const hunkNewStart = snippetBaseLine + prefixLen - ctxBefore;
  const hunkOldLen = ctxBefore + oldChanged.length + ctxAfter;
  const hunkNewLen = ctxBefore + newChanged.length + ctxAfter;

  lines.push(`@@ -${hunkOldStart},${hunkOldLen} +${hunkNewStart},${hunkNewLen} @@`);

  for (let i = prefixLen - ctxBefore; i < prefixLen; i++) {
    lines.push(` ${oldLines[i]}`);
  }
  for (const l of oldChanged) lines.push(`-${l}`);
  for (const l of newChanged) lines.push(`+${l}`);
  for (let i = oldLines.length - suffixLen; i < oldLines.length - suffixLen + ctxAfter; i++) {
    lines.push(` ${oldLines[i]}`);
  }

  return lines.join('\n');
}

interface EditChangeEntry {
  filePath: string;
  oldValue: string;
  newValue: string;
  rawDiff?: string;
  status: FileStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUnifiedDiff(filePath: string, diff: string): string {
  if (diff.startsWith('diff --git') || diff.startsWith('--- ')) return diff;
  return `--- a/${filePath}\n+++ b/${filePath}\n${diff}`;
}

function statusForChangeType(type: unknown): FileStatus {
  if (type === 'add' || type === 'create') return 'added';
  if (type === 'delete' || type === 'remove') return 'deleted';
  if (type === 'move' || type === 'rename') return 'renamed';
  return 'modified';
}

function getEditChangeEntries(parsed: Record<string, unknown>): EditChangeEntry[] {
  const changes = parsed.changes;
  if (isRecord(changes)) {
    const entries: EditChangeEntry[] = [];
    for (const [filePath, rawChange] of Object.entries(changes)) {
      if (!filePath || !isRecord(rawChange)) continue;

      const status = statusForChangeType(rawChange.type);
      const unifiedDiff = rawChange.unified_diff;
      if (typeof unifiedDiff === 'string' && unifiedDiff.trim()) {
        const rawDiff = normalizeUnifiedDiff(filePath, unifiedDiff);
        entries.push({
          filePath,
          oldValue: parseDiffOld(rawDiff),
          newValue: parseDiffNew(rawDiff),
          rawDiff,
          status,
        });
        continue;
      }

      const content = rawChange.content;
      if (typeof content !== 'string') continue;
      entries.push({
        filePath,
        oldValue: status === 'deleted' ? content : '',
        newValue: status === 'deleted' ? '' : content,
        status,
      });
    }
    if (entries.length > 0) return entries;
  }

  const filePath = parsed.file_path;
  const oldString = parsed.old_string;
  const newString = parsed.new_string;
  if (typeof filePath !== 'string' || typeof newString !== 'string') return [];
  const oldValue = typeof oldString === 'string' ? oldString : '';
  if (oldValue === newString) return [];
  return [
    {
      filePath,
      oldValue,
      newValue: newString,
      status: typeof oldString === 'string' ? 'modified' : 'added',
    },
  ];
}

function getDialogDiffData(changeEntries: EditChangeEntry[]): {
  dialogFiles?: FileDiffSummary[];
  diffCache?: Map<string, string>;
} {
  const dialogFiles =
    changeEntries.length > 1
      ? changeEntries.map((entry) => ({
          path: entry.filePath,
          status: entry.status,
          staged: false,
        }))
      : undefined;
  const entriesWithRawDiff = changeEntries.filter((entry) => entry.rawDiff);
  const diffCache =
    entriesWithRawDiff.length > 0
      ? new Map(entriesWithRawDiff.map((entry) => [entry.filePath, entry.rawDiff!]))
      : undefined;
  return { dialogFiles, diffCache };
}

export function EditFileCard({
  parsed,
  hideLabel,
  displayTime,
}: {
  parsed: Record<string, unknown>;
  hideLabel?: boolean;
  displayTime?: string | null;
}) {
  const { t } = useTranslation();
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const projectPath = useCurrentProjectPath();
  const changeEntries = useMemo(() => getEditChangeEntries(parsed), [parsed]);
  const [requestedFilePath, setRequestedFilePath] = useState<string | null>(null);
  const activeEntry =
    changeEntries.find((entry) => entry.filePath === requestedFilePath) ?? changeEntries[0];
  const filePath = activeEntry?.filePath;
  const oldString = activeEntry?.oldValue;
  const newString = activeEntry?.newValue;
  const rawDiff = activeEntry?.rawDiff;
  const displayPath = filePath
    ? `${makeRelativePath(filePath, projectPath)}${changeEntries.length > 1 ? ` +${changeEntries.length - 1}` : ''}`
    : undefined;
  const { dialogFiles, diffCache } = useMemo(
    () => getDialogDiffData(changeEntries),
    [changeEntries],
  );

  const threadId = useThreadId();

  // Open by default in the thread; collapsed when nested inside a ToolCallGroup.
  const [expanded, setExpanded] = useState(!hideLabel);
  const [showExpandedDiff, setShowExpandedDiff] = useState(false);
  const [diffMounted, setDiffMounted] = useState(false);
  const [snippetBaseLine, setSnippetBaseLine] = useState<number>(1);
  const diffObserverRef = useRef<IntersectionObserver | null>(null);

  // `snippetBaseLine` only feeds the rendered diff (computeUnifiedDiff /
  // baseLine prop), which itself is gated behind `diffMounted`. Reading the
  // file on mount for *every* card floods `/files/read` when a transcript has
  // hundreds of Edit/Write cards (e.g. an imported Claude Code session). Gate
  // the read on `diffMounted` so only cards whose diff is actually on-screen
  // fetch the file.
  useEffect(() => {
    if (!diffMounted) return;
    if (rawDiff) return;
    if (!filePath || newString == null) return;
    let cancelled = false;
    api.readFile(filePath).then((result) => {
      if (cancelled || result.isErr()) return;
      const content = result.value.content;
      const idx = content.indexOf(newString);
      if (idx < 0) return;
      const baseLine = content.slice(0, idx).split('\n').length;
      setSnippetBaseLine(baseLine);
    });
    return () => {
      cancelled = true;
    };
  }, [diffMounted, filePath, newString, rawDiff]);

  const diffSlotRef = useCallback(
    (el: HTMLDivElement | null) => {
      diffObserverRef.current?.disconnect();
      diffObserverRef.current = null;

      if (!el || !expanded || diffMounted) return;
      if (typeof IntersectionObserver === 'undefined') {
        setDiffMounted(true);
        return;
      }

      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            setDiffMounted(true);
            io.disconnect();
          }
        },
        { rootMargin: '600px 0px' },
      );
      diffObserverRef.current = io;
      io.observe(el);
    },
    [diffMounted, expanded],
  );

  useEffect(() => () => diffObserverRef.current?.disconnect(), []);

  const requestFullDiff = useCallback(
    async (
      path: string,
    ): Promise<{ oldValue: string; newValue: string; rawDiff?: string } | null> => {
      if (!threadId) return null;
      const result = await api.getFileDiff(threadId, path, false, undefined, 'full');
      if (result.isOk()) {
        return {
          oldValue: parseDiffOld(result.value.diff),
          newValue: parseDiffNew(result.value.diff),
          rawDiff: result.value.diff,
        };
      }
      return null;
    },
    [threadId],
  );

  const hasDiff = useMemo(() => {
    return !!activeEntry && oldString != null && newString != null && oldString !== newString;
  }, [activeEntry, oldString, newString]);

  const unifiedDiff = useMemo(() => {
    if (!hasDiff) return '';
    if (rawDiff) return rawDiff;
    return computeUnifiedDiff(oldString || '', newString || '', snippetBaseLine);
  }, [hasDiff, oldString, newString, rawDiff, snippetBaseLine]);
  const inlineDiffSlotHeight = useMemo(() => {
    if (!hasDiff) return undefined;
    const rowHeight = DIFF_ROW_HEIGHT_PX[fontSize];
    const lineCount = Math.max(1, unifiedDiff.split('\n').length);
    return Math.max(64, lineCount * rowHeight);
  }, [fontSize, hasDiff, unifiedDiff]);

  return (
    <div className="border-border w-full min-w-0 overflow-hidden rounded-lg border text-sm">
      <div className="flex w-full items-center overflow-hidden">
        <div className="flex min-w-0 flex-1 items-center overflow-hidden">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="hover:bg-accent/30 flex shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs"
          >
            <ChevronRight
              className={cn('icon-xs shrink-0 text-muted-foreground', expanded && 'rotate-90')}
            />
            {!hideLabel && <FilePen className="icon-xs text-muted-foreground shrink-0" />}
            {!hideLabel && (
              <span className="text-foreground shrink-0 font-mono font-medium">
                {t('tools.editFile')}
              </span>
            )}
          </button>
          {filePath &&
            (() => {
              // When a diff is available, clicking the path opens the diff
              // popup. Otherwise fall back to opening the file in the editor.
              if (hasDiff) {
                return (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowExpandedDiff(true);
                        }}
                        className="text-muted-foreground hover:text-primary min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-mono text-xs hover:underline"
                      >
                        {displayPath}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t('review.expand', 'Expand')}</TooltipContent>
                  </Tooltip>
                );
              }
              const editorUri = toEditorUri(filePath, defaultEditor);
              const editorTitle = t('tools.openInEditor', {
                editor: getEditorLabel(defaultEditor),
                path: filePath,
              });
              return (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {editorUri ? (
                      <a
                        href={editorUri}
                        onClick={(e) => e.stopPropagation()}
                        className="text-muted-foreground hover:text-primary min-w-0 truncate font-mono text-xs hover:underline"
                      >
                        {displayPath}
                      </a>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          openFileInEditor(filePath, defaultEditor);
                        }}
                        className="text-muted-foreground hover:text-primary min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-mono text-xs hover:underline"
                      >
                        {displayPath}
                      </button>
                    )}
                  </TooltipTrigger>
                  <TooltipContent>{editorTitle}</TooltipContent>
                </Tooltip>
              );
            })()}
          {displayTime && (
            <span className="text-muted-foreground/50 ml-auto shrink-0 text-[10px] tabular-nums">
              {displayTime}
            </span>
          )}
        </div>
        {hasDiff && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setShowExpandedDiff(true)}
                className="text-muted-foreground hover:text-foreground mr-1 shrink-0"
              >
                <Maximize2 className="icon-sm" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{t('review.expand', 'Expand')}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {expanded && hasDiff && (
        <div
          ref={diffSlotRef}
          className="border-border/40 max-h-[50vh] overflow-hidden border-t"
          style={{ height: inlineDiffSlotHeight }}
        >
          {diffMounted ? (
            <VirtualDiff
              unifiedDiff={unifiedDiff}
              splitView={false}
              filePath={filePath}
              codeFolding={true}
              className="h-full max-h-[50vh]"
              data-testid="edit-file-inline-diff"
            />
          ) : (
            <div className="h-16" data-testid="edit-file-inline-diff-placeholder" />
          )}
        </div>
      )}
      <ExpandedDiffDialog
        open={showExpandedDiff}
        onOpenChange={setShowExpandedDiff}
        filePath={filePath || ''}
        oldValue={oldString || ''}
        newValue={newString || ''}
        baseLine={snippetBaseLine}
        files={dialogFiles}
        onFileSelect={dialogFiles ? setRequestedFilePath : undefined}
        diffCache={diffCache}
        basePath={projectPath}
        onRequestFullDiff={requestFullDiff}
      />
    </div>
  );
}
