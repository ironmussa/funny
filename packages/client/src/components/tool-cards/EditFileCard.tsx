import { useState, useMemo, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FilePen, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toEditorUri, openFileInEditor, getEditorLabel, ReactDiffViewer, DIFF_VIEWER_STYLES } from './utils';
import { useSettingsStore } from '@/stores/settings-store';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ExpandedDiffDialog } from './ExpandedDiffDialog';

export function EditFileCard({ parsed, hideLabel }: { parsed: Record<string, unknown>; hideLabel?: boolean }) {
  const { t } = useTranslation();
  const defaultEditor = useSettingsStore(s => s.defaultEditor);
  const filePath = parsed.file_path as string | undefined;
  const oldString = parsed.old_string as string | undefined;
  const newString = parsed.new_string as string | undefined;

  const [expanded, setExpanded] = useState(true);
  const [showExpandedDiff, setShowExpandedDiff] = useState(false);

  const hasDiff = useMemo(() => {
    return filePath && oldString != null && newString != null && oldString !== newString;
  }, [filePath, oldString, newString]);

  return (
    <div className="text-sm w-full min-w-0 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs hover:bg-accent/30 transition-colors rounded-md overflow-hidden"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90'
          )}
        />
        {!hideLabel && <FilePen className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
        {!hideLabel && <span className="font-medium font-mono text-foreground flex-shrink-0">{t('tools.editFile')}</span>}
        {filePath && (
          (() => {
            const editorUri = toEditorUri(filePath, defaultEditor);
            const editorTitle = t('tools.openInEditor', { editor: getEditorLabel(defaultEditor), path: filePath });
            return editorUri ? (
              <a
                href={editorUri}
                onClick={(e) => e.stopPropagation()}
                className="text-muted-foreground truncate font-mono text-xs min-w-0 hover:text-primary hover:underline"
                title={editorTitle}
              >
                {filePath}
              </a>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); openFileInEditor(filePath, defaultEditor); }}
                className="text-muted-foreground truncate font-mono text-xs min-w-0 hover:text-primary hover:underline text-left"
                title={editorTitle}
              >
                {filePath}
              </button>
            );
          })()
        )}
      </button>
      {expanded && hasDiff && (
        <div className="border-t border-border/40 overflow-hidden">
          <div className="relative text-xs max-h-80 overflow-y-auto overflow-x-auto [&_.diff-container]:font-mono [&_.diff-container]:text-sm">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon-xs"
                  onClick={() => setShowExpandedDiff(true)}
                  className="absolute top-2 right-2 z-10 opacity-70 hover:opacity-100 shadow-md"
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{t('review.expand', 'Expand')}</TooltipContent>
            </Tooltip>
            <Suspense fallback={<div className="p-2 text-xs text-muted-foreground">Loading diff...</div>}>
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
