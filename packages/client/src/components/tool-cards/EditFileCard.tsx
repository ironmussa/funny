import { useState, useMemo, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FilePen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toVscodeUri, ReactDiffViewer, DIFF_VIEWER_STYLES } from './utils';

export function EditFileCard({ parsed }: { parsed: Record<string, unknown> }) {
  const { t } = useTranslation();
  const filePath = parsed.file_path as string | undefined;
  const oldString = parsed.old_string as string | undefined;
  const newString = parsed.new_string as string | undefined;

  const [expanded, setExpanded] = useState(true);

  const hasDiff = useMemo(() => {
    return filePath && oldString != null && newString != null && oldString !== newString;
  }, [filePath, oldString, newString]);

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 text-sm w-full min-w-0 overflow-hidden">
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
        <FilePen className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground flex-shrink-0">{t('tools.editFile')}</span>
        {filePath && (
          <a
            href={toVscodeUri(filePath)}
            onClick={(e) => e.stopPropagation()}
            className="text-muted-foreground truncate font-mono text-[11px] min-w-0 hover:text-primary hover:underline"
            title={t('tools.openInVSCode', { path: filePath })}
          >
            {filePath}
          </a>
        )}
      </button>
      {expanded && hasDiff && (
        <div className="border-t border-border/40 overflow-hidden">
          <div className="text-xs max-h-80 overflow-y-auto overflow-x-auto [&_.diff-container]:font-mono [&_.diff-container]:text-[11px]">
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
    </div>
  );
}
