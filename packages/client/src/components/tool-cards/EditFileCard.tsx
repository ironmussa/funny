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
import { useThreadStore } from '@/stores/thread-store';

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
 */
function computeUnifiedDiff(oldValue: string, newValue: string): string {
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
  const hunkOldStart = prefixLen - ctxBefore + 1;
  const hunkNewStart = prefixLen - ctxBefore + 1;
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

  const threadId = useThreadStore((s) => s.activeThread?.id);

  const [expanded, setExpanded] = useState(true);
  const [showExpandedDiff, setShowExpandedDiff] = useState(false);
  const [diffMounted, setDiffMounted] = useState(false);
  const diffSlotRef = useRef<HTMLDivElement | null>(null);

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
    return computeUnifiedDiff(oldString || '', newString || '');
  }, [hasDiff, oldString, newString]);

  return (
    <div className="w-full min-w-0 overflow-hidden rounded-lg border border-border text-sm">
      <div className="flex w-full items-center overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/30"
        >
          <ChevronRight
            className={cn(
              'icon-xs flex-shrink-0 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
          {!hideLabel && <FilePen className="icon-xs flex-shrink-0 text-muted-foreground" />}
          {!hideLabel && (
            <span className="flex-shrink-0 font-mono font-medium text-foreground">
              {t('tools.editFile')}
            </span>
          )}
          {filePath &&
            (() => {
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
                        className="min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
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
                        className="min-w-0 cursor-pointer truncate text-left font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
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
            <span className="ml-auto flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
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
                className="mr-1 flex-shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Maximize2 className="icon-sm" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{t('review.expand', 'Expand')}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {expanded && hasDiff && (
        <div ref={diffSlotRef} className="max-h-[50vh] overflow-hidden border-t border-border/40">
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
        onRequestFullDiff={requestFullDiff}
      />
    </div>
  );
}
