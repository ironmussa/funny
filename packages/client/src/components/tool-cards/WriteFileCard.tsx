import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toEditorUri, openFileInEditor, getEditorLabel, getFileExtension, getFileName } from './utils';
import { useSettingsStore } from '@/stores/settings-store';

export function WriteFileCard({ parsed, hideLabel }: { parsed: Record<string, unknown>; hideLabel?: boolean }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const defaultEditor = useSettingsStore(s => s.defaultEditor);
  const filePath = parsed.file_path as string | undefined;
  const content = parsed.content as string | undefined;
  const ext = filePath ? getFileExtension(filePath) : '';
  const fileName = filePath ? getFileName(filePath) : 'unknown';

  return (
    <div className="text-sm max-w-full overflow-hidden">
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
        {!hideLabel && <FileText className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
        {!hideLabel && <span className="font-medium font-mono text-foreground flex-shrink-0">{t('tools.writeFile')}</span>}
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
      {expanded && content != null && (
        <div className="border-t border-border/40 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1 bg-background/50 border-b border-border/30">
            <span className="text-xs font-medium text-muted-foreground">{fileName}</span>
            {ext && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-mono">
                {ext}
              </span>
            )}
          </div>
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <pre className="px-3 py-2 font-mono text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap break-all">
              {content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
