import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { VirtualDiff } from '@/components/VirtualDiff';
import { cn } from '@/lib/utils';
import type { Editor } from '@/stores/settings-store';

import { MobileContentPreview } from './MobileContentPreview';
import { toEditorUri, openFileInEditor, getEditorLabel } from './utils';

const PATH_BUTTON_CLASS =
  'text-muted-foreground hover:text-primary min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-mono text-xs hover:underline';

/**
 * The edited file's path. When a diff is available, clicking it opens the
 * diff popup. Otherwise it falls back to opening the file in the editor.
 */
export function EditFilePathLink({
  filePath,
  displayPath,
  hasDiff,
  defaultEditor,
  onExpand,
}: {
  filePath: string;
  displayPath: string | undefined;
  hasDiff: boolean;
  defaultEditor: Editor;
  onExpand: () => void;
}) {
  const { t } = useTranslation();
  if (hasDiff) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onExpand();
            }}
            className={PATH_BUTTON_CLASS}
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
            className={PATH_BUTTON_CLASS}
          >
            {displayPath}
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent>{editorTitle}</TooltipContent>
    </Tooltip>
  );
}

/** The inline diff, mounted once its slot is near the viewport. */
export function EditFileInlineDiff({
  slotRef,
  slotHeight,
  diffMounted,
  unifiedDiff,
  filePath,
  contextLines,
  onExpand,
}: {
  slotRef: (el: HTMLDivElement | null) => void;
  slotHeight: number | undefined;
  diffMounted: boolean;
  unifiedDiff: string;
  filePath: string | undefined;
  contextLines: number;
  onExpand: () => void;
}) {
  const { t } = useTranslation();
  return (
    <MobileContentPreview onExpand={onExpand} label={t('tools.viewFullDiff')}>
      <div
        ref={slotRef}
        className={cn(
          'border-border/40 max-h-[50vh] overflow-hidden border-t',
          slotHeight !== undefined && 'h-[var(--edit-file-diff-slot-height)]',
        )}
        style={{
          '--edit-file-diff-slot-height': slotHeight === undefined ? undefined : `${slotHeight}px`,
        }}
      >
        {diffMounted ? (
          <VirtualDiff
            unifiedDiff={unifiedDiff}
            splitView={false}
            filePath={filePath}
            codeFolding={true}
            contextLines={contextLines}
            className="h-full max-h-[50vh]"
            data-testid="edit-file-inline-diff"
          />
        ) : (
          <div
            className="text-muted-foreground flex h-16 items-center gap-2 px-3 text-xs"
            data-testid="edit-file-inline-diff-placeholder"
          >
            <Loader2 className="icon-xs animate-spin" />
            <span>{t('tools.loadingDiff', 'Loading diff…')}</span>
          </div>
        )}
      </div>
    </MobileContentPreview>
  );
}

/** Shown when the live diff could not be loaded (e.g. untracked file). */
export function EditFileDiffUnavailable({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="border-border/40 flex min-h-16 items-center justify-between gap-3 border-t px-3 py-2 text-xs"
      data-testid="edit-file-inline-diff-unavailable"
    >
      <span className="text-muted-foreground">
        {t(
          'tools.diffUnavailableNoTracking',
          'The diff cannot be shown because this file is not tracked by Git.',
        )}
      </span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        {t('common.retry', 'Retry')}
      </Button>
    </div>
  );
}
