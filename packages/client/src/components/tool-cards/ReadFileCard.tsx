import { FileSearch } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useSettingsStore } from '@/stores/settings-store';

import {
  toEditorUri,
  openFileInEditor,
  getEditorLabel,
  useCurrentProjectPath,
  makeRelativePath,
} from './utils';

export function ReadFileCard({
  parsed,
  hideLabel,
}: {
  parsed: Record<string, unknown>;
  output?: string;
  hideLabel?: boolean;
}) {
  const { t } = useTranslation();
  const defaultEditor = useSettingsStore((s) => s.defaultEditor);
  const filePath = parsed.file_path as string | undefined;
  const projectPath = useCurrentProjectPath();
  const displayPath = filePath ? makeRelativePath(filePath, projectPath) : undefined;

  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border text-sm">
      <div className="flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs">
        {!hideLabel && <FileSearch className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
        {!hideLabel && (
          <span className="flex-shrink-0 font-mono font-medium text-foreground">
            {t('tools.readFile')}
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
                className="min-w-0 truncate font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
                title={editorTitle}
              >
                {displayPath}
              </a>
            ) : (
              <span
                role="button"
                tabIndex={0}
                onClick={() => openFileInEditor(filePath, defaultEditor)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
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
      </div>
    </div>
  );
}
