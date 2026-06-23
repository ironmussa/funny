import { ChevronRight, FilePen, Maximize2 } from 'lucide-react';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { VirtualDiff } from '@/components/VirtualDiff';
import { api } from '@/lib/api';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings-store';
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
  const filePath = parsed.file_path as string | undefined;
  const projectPath = useCurrentProjectPath();
  const displayPath = filePath ? makeRelativePath(filePath, projectPath) : undefined;
  const oldString = parsed.old_string as string | undefined;
  const newString = parsed.new_string as string | undefined;

  const threadId = useThreadId();

  // Open by default in the thread; collapsed when nested inside a ToolCallGroup.
  const [expanded, setExpanded] = useState(!hideLabel);
  const [showExpandedDiff, setShowExpandedDiff] = useState(false);
  const [diffMounted, setDiffMounted] = useState(false);
  const [snippetBaseLine, setSnippetBaseLine] = useState<number>(1);
  const diffSlotRef = useRef<HTMLDivElement | null>(null);

  // `snippetBaseLine` only feeds the rendered diff (computeUnifiedDiff /
  // baseLine prop), which itself is gated behind `diffMounted`. Reading the
  // file on mount for *every* card floods `/files/read` when a transcript has
  // hundreds of Edit/Write cards (e.g. an imported Claude Code session). Gate
  // the read on `diffMounted` so only cards whose diff is actually on-screen
  // fetch the file.
  useEffect(() => {
    if (!diffMounted) return;
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
  }, [diffMounted, filePath, newString]);

  useEffect(() => {
    if (!expanded || diffMounted) return;
    const el = diffSlotRef.current;
    if (!el) return;
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
    io.observe(el);
    return () => io.disconnect();
  }, [expanded, diffMounted]);

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
    return filePath && oldString != null && newString != null && oldString !== newString;
  }, [filePath, oldString, newString]);

  const unifiedDiff = useMemo(() => {
    if (!hasDiff) return '';
    return computeUnifiedDiff(oldString || '', newString || '', snippetBaseLine);
  }, [hasDiff, oldString, newString, snippetBaseLine]);

  return (
    <div className="border-border w-full min-w-0 overflow-hidden rounded-lg border text-sm">
      <div className="flex w-full items-center overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="hover:bg-accent/30 flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs transition-colors"
        >
          <ChevronRight
            className={cn(
              'icon-xs shrink-0 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
          {!hideLabel && <FilePen className="icon-xs text-muted-foreground shrink-0" />}
          {!hideLabel && (
            <span className="text-foreground shrink-0 font-mono font-medium">
              {t('tools.editFile')}
            </span>
          )}
          {filePath &&
            (() => {
              // When a diff is available, clicking the path opens the diff
              // popup. Otherwise fall back to opening the file in the editor.
              if (hasDiff) {
                return (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowExpandedDiff(true);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.stopPropagation();
                            setShowExpandedDiff(true);
                          }
                        }}
                        className="text-muted-foreground hover:text-primary min-w-0 cursor-pointer truncate text-left font-mono text-xs hover:underline"
                      >
                        {displayPath}
                      </span>
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
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          openFileInEditor(filePath, defaultEditor);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.stopPropagation();
                            openFileInEditor(filePath, defaultEditor);
                          }
                        }}
                        className="text-muted-foreground hover:text-primary min-w-0 cursor-pointer truncate text-left font-mono text-xs hover:underline"
                      >
                        {displayPath}
                      </span>
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
        </button>
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
        <div ref={diffSlotRef} className="border-border/40 max-h-[50vh] overflow-hidden border-t">
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
        onRequestFullDiff={requestFullDiff}
      />
    </div>
  );
}
