import Editor, { type BeforeMount, type OnMount } from '@monaco-editor/react';
import { Code, Loader2, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

import { useViewerStore } from '../stores/viewer-store';

function getMonacoLanguage(ext: string): string {
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    css: 'css',
    html: 'html',
  };
  return map[ext] || 'plaintext';
}

const handleBeforeMount: BeforeMount = (monaco) => {
  monaco.editor.defineTheme('evflow-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0a0a0b',
      'editorGutter.background': '#0a0a0b',
    },
  });
};

export function SourcePanel() {
  const sourceContent = useViewerStore((s) => s.sourceContent);
  const sourceLoading = useViewerStore((s) => s.sourceLoading);
  const sourceError = useViewerStore((s) => s.sourceError);
  const activeSource = useViewerStore((s) => s.activeSource);
  const setSourcePanelOpen = useViewerStore((s) => s.setSourcePanelOpen);

  if (!activeSource) return null;

  const ext = activeSource.file.split('.').pop() || '';
  const language = activeSource.language || getMonacoLanguage(ext);

  const handleMount: OnMount = (editor, monaco) => {
    if (activeSource.startLine) {
      editor.revealLineInCenter(activeSource.startLine);
      const endLine = activeSource.endLine || activeSource.startLine;
      editor.createDecorationsCollection([
        {
          range: new monaco.Range(activeSource.startLine, 1, endLine, 1),
          options: {
            isWholeLine: true,
            className: 'source-highlight-line',
            linesDecorationsClassName: 'source-highlight-gutter',
          },
        },
      ]);
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="viewer-source-panel">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Code className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{activeSource.file}</span>
        {activeSource.exportName && (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {activeSource.exportName}
          </Badge>
        )}
        {activeSource.startLine && (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            L{activeSource.startLine}
            {activeSource.endLine ? `–${activeSource.endLine}` : ''}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0"
          onClick={() => setSourcePanelOpen(false)}
          data-testid="viewer-source-close"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      <Separator />

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {sourceLoading && (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading source...
          </div>
        )}
        {sourceError && (
          <div className="p-3 text-xs text-destructive" data-testid="viewer-source-error">
            {sourceError}
          </div>
        )}
        {sourceContent && !sourceLoading && (
          <Editor
            height="100%"
            language={language}
            theme="evflow-dark"
            beforeMount={handleBeforeMount}
            onMount={handleMount}
            value={sourceContent}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: 'on',
              automaticLayout: true,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              domReadOnly: true,
              renderValidationDecorations: 'off',
            }}
          />
        )}
      </div>
    </div>
  );
}
