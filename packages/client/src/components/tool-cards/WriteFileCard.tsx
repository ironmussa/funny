import { ChevronRight, FileText } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings-store';

import {
  toEditorUri,
  openFileInEditor,
  getEditorLabel,
  getFileExtension,
  getFileName,
  useCurrentProjectPath,
  makeRelativePath,
} from './utils';

export function WriteFileCard({
  parsed,
  hideLabel,
}: {
  parsed: Record<string, unknown>;
  hideLabel?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const filePath = parsed.file_path as string | undefined;
  const projectPath = useCurrentProjectPath();
  const displayPath = filePath ? makeRelativePath(filePath, projectPath) : undefined;
  const content = parsed.content as string | undefined;
  const ext = filePath ? getFileExtension(filePath) : '';
  const fileName = filePath ? getFileName(filePath) : 'unknown';

  return (
    <div className="max-w-full overflow-hidden text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/30"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        {!hideLabel && <FileText className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
        {!hideLabel && (
          <span className="flex-shrink-0 font-mono font-medium text-foreground">
            {t('tools.writeFile')}
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
      {expanded && content != null && (
        <div className="overflow-hidden border-t border-border/40">
          <div className="flex items-center justify-between border-b border-border/30 bg-background/50 px-3 py-1">
            <span className="text-xs font-medium text-muted-foreground">{fileName}</span>
            {ext && (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {ext}
              </span>
            )}
          </div>
          <div className="max-h-80 overflow-hidden">
            <pre className="whitespace-pre-wrap break-all px-3 py-2 font-mono text-sm leading-relaxed text-foreground/80">
              {content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
