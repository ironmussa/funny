import type { FileDiffSummary, FileStatus } from '@funny/shared';
import { isJsonObject, type JsonObject } from '@funny/shared/json';
import { ChevronRight, FilePen, Maximize2 } from 'lucide-react';
import { useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';
import { computeUnifiedDiff } from '@/lib/snippet-unified-diff';
import { cn } from '@/lib/utils';
import { DIFF_ROW_HEIGHT_PX, useSettingsStore } from '@/stores/settings-store';
import { useThreadId } from '@/stores/thread-context';

import { EditFileDiffUnavailable, EditFileInlineDiff, EditFilePathLink } from './EditFileCardParts';
import { ExpandedDiffDialog } from './ExpandedDiffDialog';
import {
  computeInlineDiffSlotHeight,
  useDiffMountOnVisible,
  useLiveFileDiff,
  useSnippetBaseLine,
} from './use-edit-file-diff';
import {
  useCurrentProjectPath,
  // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- plain utility function, not an Effect service constructor
  makeRelativePath,
} from './utils';

const INLINE_DIFF_CONTEXT_LINES = 3;

interface EditChangeEntry {
  filePath: string;
  oldValue?: string;
  newValue?: string;
  rawDiff?: string;
  status: FileStatus;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function normalizeUnifiedDiff(filePath: string, diff: string): string {
  if (diff.startsWith('diff --git') || diff.startsWith('--- ')) return diff;
  return `--- a/${filePath}\n+++ b/${filePath}\n${diff}`;
}

/** The file status a change reports in `change[key]` (`type` in Claude edits, `kind` in Codex). */
function statusForChangeType(
  change: { type?: unknown; kind?: unknown },
  key: 'type' | 'kind',
): FileStatus {
  const type = change[key];
  if (type === 'add' || type === 'create') return 'added';
  if (type === 'delete' || type === 'remove') return 'deleted';
  if (type === 'move' || type === 'rename') return 'renamed';
  return 'modified';
}

function getEditChangeEntries(parsed: JsonObject): EditChangeEntry[] {
  const changes = parsed.changes;
  if (isJsonObject(changes)) {
    const entries: EditChangeEntry[] = [];
    for (const [filePath, rawChange] of Object.entries(changes)) {
      if (!filePath || !isJsonObject(rawChange)) continue;

      const status = statusForChangeType(rawChange, 'type');
      const unifiedDiff = rawChange.unified_diff;
      if (isString(unifiedDiff) && unifiedDiff.trim()) {
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
      if (isString(content)) {
        entries.push({
          filePath,
          oldValue: status === 'deleted' ? content : '',
          newValue: status === 'deleted' ? '' : content,
          status,
        });
      } else {
        // Keep entries without a captured patch so the client can still
        // request the live diff for legacy SDK events.
        entries.push({ filePath, status });
      }
    }
    if (entries.length > 0) return entries;
  }

  // `@openai/codex-sdk` reports a completed file change as a lightweight
  // array of `{ path, kind }` objects. It intentionally does not include the
  // patch text, so retain the paths here and load the actual diff on demand.
  if (Array.isArray(changes)) {
    return changes.flatMap((change) => {
      if (!isJsonObject(change) || !isString(change.path) || !change.path) return [];
      return [{ filePath: change.path, status: statusForChangeType(change, 'kind') }];
    });
  }

  const filePath = parsed.file_path;
  const oldString = parsed.old_string;
  const newString = parsed.new_string;
  if (!isString(filePath) || !isString(newString)) return [];
  const oldValue = isString(oldString) ? oldString : '';
  if (oldValue === newString) return [];
  return [
    {
      filePath,
      oldValue,
      newValue: newString,
      status: isString(oldString) ? 'modified' : 'added',
    },
  ];
}

/** The diff dialog's file list and its raw diffs, when an edit touched several files. */
interface DialogDiffData {
  dialogFiles?: FileDiffSummary[];
  diffCache?: Map<string, string>;
}

function getDialogDiffData(changeEntries: EditChangeEntry[]): DialogDiffData {
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
  parsed: JsonObject;
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
  // Codex reports absolute paths when its working directory is absolute, while
  // the Git endpoint (and native Git implementation) expects a path relative
  // to the thread worktree.
  const diffFilePath = filePath ? makeRelativePath(filePath, projectPath) : undefined;
  const displayPath = filePath
    ? `${makeRelativePath(filePath, projectPath)}${changeEntries.length > 1 ? ` +${changeEntries.length - 1}` : ''}`
    : undefined;
  const { dialogFiles, diffCache } = useMemo(
    () => getDialogDiffData(changeEntries),
    [changeEntries],
  );

  const threadId = useThreadId();

  // hideLabel selects the initial uncontrolled state; user toggles own expansion after mount.
  // react-doctor-disable-next-line no-derived-useState
  const [expanded, setExpanded] = useState(!hideLabel);
  const [showExpandedDiff, setShowExpandedDiff] = useState(false);
  const openExpandedDiff = useCallback(() => setShowExpandedDiff(true), []);

  const {
    oldString,
    newString,
    rawDiff,
    hasCapturedDiff,
    isDiffLoading,
    isDiffUnavailable,
    retryDiff,
  } = useLiveFileDiff({ expanded, activeEntry, diffFilePath, threadId });

  const { diffMounted, diffSlotRef } = useDiffMountOnVisible(expanded);
  const snippetBaseLine = useSnippetBaseLine({
    diffMounted,
    rawDiff,
    filePath,
    newString,
    projectPath,
  });

  const requestFullDiff = useCallback(
    async (
      path: string,
    ): Promise<{ oldValue: string; newValue: string; rawDiff?: string } | null> => {
      if (!threadId) return null;
      const result = await api.getFileDiff(
        threadId,
        makeRelativePath(path, projectPath),
        false,
        undefined,
        'full',
      );
      if (result.isOk()) {
        return {
          oldValue: parseDiffOld(result.value.diff),
          newValue: parseDiffNew(result.value.diff),
          rawDiff: result.value.diff,
        };
      }
      return null;
    },
    [projectPath, threadId],
  );

  const hasDiff = useMemo(() => {
    return (
      !!activeEntry &&
      oldString != null &&
      newString != null &&
      oldString !== newString &&
      (!rawDiff || hasCapturedDiff)
    );
  }, [activeEntry, hasCapturedDiff, oldString, newString, rawDiff]);

  const unifiedDiff = useMemo(() => {
    if (!hasDiff) return '';
    if (rawDiff) return rawDiff;
    return computeUnifiedDiff(oldString || '', newString || '', snippetBaseLine);
  }, [hasDiff, oldString, newString, rawDiff, snippetBaseLine]);
  const inlineDiffSlotHeight = useMemo(() => {
    if (!hasDiff) return undefined;
    return computeInlineDiffSlotHeight(
      unifiedDiff,
      DIFF_ROW_HEIGHT_PX[fontSize],
      INLINE_DIFF_CONTEXT_LINES,
    );
  }, [fontSize, hasDiff, unifiedDiff]);

  return (
    <div
      data-expanded={expanded}
      className="tool-card-frame w-full min-w-0 overflow-hidden rounded-lg text-sm"
    >
      <div className="flex w-full items-center overflow-hidden">
        <div className="flex min-w-0 flex-1 items-center overflow-hidden">
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-label={t('tools.editFile')}
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
          {filePath && (
            <EditFilePathLink
              filePath={filePath}
              displayPath={displayPath}
              hasDiff={hasDiff}
              defaultEditor={defaultEditor}
              onExpand={openExpandedDiff}
            />
          )}
          {displayTime && (
            <span className="text-muted-foreground/50 text-2xs ml-auto shrink-0 tabular-nums">
              {displayTime}
            </span>
          )}
        </div>
        {hasDiff && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="muted"
                size="icon-xs"
                onClick={() => setShowExpandedDiff(true)}
                className="mr-1 shrink-0"
              >
                <Maximize2 className="icon-sm" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{t('review.expand', 'Expand')}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {expanded && hasDiff && (
        <EditFileInlineDiff
          slotRef={diffSlotRef}
          slotHeight={inlineDiffSlotHeight}
          diffMounted={diffMounted}
          unifiedDiff={unifiedDiff}
          filePath={filePath}
          contextLines={INLINE_DIFF_CONTEXT_LINES}
          onExpand={openExpandedDiff}
        />
      )}
      {expanded && !hasDiff && isDiffLoading && (
        <div
          className="border-border/40 bg-muted/20 h-16 animate-pulse border-t"
          data-testid="edit-file-inline-diff-loading"
        />
      )}
      {expanded && !hasDiff && !isDiffLoading && isDiffUnavailable && filePath && (
        <EditFileDiffUnavailable onRetry={() => retryDiff(filePath)} />
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
