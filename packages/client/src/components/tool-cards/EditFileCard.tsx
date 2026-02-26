import { ChevronRight, FilePen, Maximize2 } from 'lucide-react';
import { useState, useMemo, Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings-store';

import { ExpandedDiffDialog } from './ExpandedDiffDialog';
import {
  toEditorUri,
  openFileInEditor,
  getEditorLabel,
  ReactDiffViewer,
  DIFF_VIEWER_STYLES,
  useCurrentProjectPath,
  makeRelativePath,
} from './utils';

export function EditFileCard({
  parsed,
  hideLabel,
}: {
  parsed: Record<string, unknown>;
  hideLabel?: boolean;
}) {
  const { t } = useTranslation();
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const filePath = parsed.file_path as string | undefined;
  const projectPath = useCurrentProjectPath();
  const displayPath = filePath ? makeRelativePath(filePath, projectPath) : undefined;
  const oldString = parsed.old_string as string | undefined;
  const newString = parsed.new_string as string | undefined;

  const [expanded, setExpanded] = useState(true);
  const [showExpandedDiff, setShowExpandedDiff] = useState(false);

  const hasDiff = useMemo(() => {
    return filePath && oldString != null && newString != null && oldString !== newString;
  }, [filePath, oldString, newString]);

  return (
    <div className="w-full min-w-0 overflow-hidden text-sm">
      <div className="flex w-full items-center overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/30"
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
          {!hideLabel && <FilePen className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
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
              return editorUri ? (
                <a
                  href={editorUri}
                  onClick={(e) => e.stopPropagation()}
                  className="min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
                  title={editorTitle}
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
                  title={editorTitle}
                >
                  {displayPath}
                </span>
              );
            })()}
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
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">{t('review.expand', 'Expand')}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {expanded && hasDiff && (
        <div className="overflow-hidden border-t border-border/40">
          <div className="max-h-80 overflow-hidden text-xs [&_.diff-container]:font-mono [&_.diff-container]:text-sm">
            <Suspense
              fallback={<div className="p-2 text-xs text-muted-foreground">Loading diff...</div>}
            >
              <ReactDiffViewer
                oldValue={oldString || ''}
                newValue={newString || ''}
                splitView={false}
                useDarkTheme={true}
                hideLineNumbers={false}
                showDiffOnly={true}
                styles={DIFF_VIEWER_STYLES}
              />
            </Suspense>
          </div>
        </div>
      )}
      <ExpandedDiffDialog
        open={showExpandedDiff}
        onOpenChange={setShowExpandedDiff}
        filePath={filePath || ''}
        oldValue={oldString || ''}
        newValue={newString || ''}
      />
    </div>
  );
}
