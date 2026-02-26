import { Editor, type BeforeMount } from '@monaco-editor/react';
import { Loader2, Save, X, Maximize2, Minimize2, Eye, EyeOff, BookOpen, Code } from 'lucide-react';
import mermaid from 'mermaid';
import { useTheme } from 'next-themes';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface MonacoEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  initialContent: string | null;
}

export function MonacoEditorDialog({
  open,
  onOpenChange,
  filePath,
  initialContent,
}: MonacoEditorDialogProps) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [showMinimap, setShowMinimap] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const ext = getFileExtension(filePath);
  const language = getMonacoLanguage(ext);
  const isMarkdown = language === 'markdown';

  const [showPreview, setShowPreview] = useState(isMarkdown);

  const isDirty = content !== originalContent;

  // Derive Monaco theme — all custom themes are dark-based
  const monacoTheme = resolvedTheme === 'light' ? 'vs' : 'funny-dark';

  // Define custom dark theme with black background
  const handleBeforeMount: BeforeMount = (monaco) => {
    monaco.editor.defineTheme('funny-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#000000',
        'editorGutter.background': '#000000',
        'minimap.background': '#0a0a0a',
      },
    });
  };

  // Set initial content when dialog opens
  useEffect(() => {
    if (!open || !initialContent) return;
    setContent(initialContent);
    setOriginalContent(initialContent);
  }, [open, initialContent]);

  const handleSave = async () => {
    setSaving(true);
    const result = await api.writeFile(filePath, content);
    setSaving(false);

    if (result.isOk()) {
      setOriginalContent(content);
      toast.success(t('editor.saved', 'File saved'));
    } else {
      toast.error(t('editor.failedToSave', 'Failed to save file'), {
        description: result.error.message,
      });
    }
  };

  const handleClose = () => {
    if (isDirty) {
      const confirmed = confirm(
        t('editor.unsavedChanges', 'You have unsaved changes. Close without saving?'),
      );
      if (!confirmed) return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className={cn(
          isFullscreen
            ? 'max-w-[100vw] max-h-[100vh] w-[100vw] h-[100vh] p-0'
            : 'max-w-5xl max-h-[85vh] h-[85vh] p-0',
          '[&>button:last-child]:hidden',
          '!duration-0',
          'overflow-hidden',
        )}
      >
        <DialogHeader className="overflow-hidden border-b border-border/50 px-6 pb-2 pt-4">
          <div className="flex items-center justify-between gap-2">
            <DialogTitle
              className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm"
              style={{ direction: 'rtl', textAlign: 'left' }}
            >
              {filePath}
            </DialogTitle>
            <div className="flex flex-shrink-0 items-center gap-1">
              {/* Markdown preview toggle */}
              {isMarkdown && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowPreview(!showPreview)}
                  title={
                    showPreview
                      ? t('editor.showCode', 'Show code')
                      : t('editor.showPreview', 'Show preview')
                  }
                  className="h-8 w-8"
                >
                  {showPreview ? <Code className="h-4 w-4" /> : <BookOpen className="h-4 w-4" />}
                </Button>
              )}

              {/* Minimap toggle */}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowMinimap(!showMinimap)}
                title={showMinimap ? t('editor.hideMinimap') : t('editor.showMinimap')}
                className="h-8 w-8"
              >
                {showMinimap ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>

              {/* Fullscreen toggle */}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsFullscreen(!isFullscreen)}
                title={isFullscreen ? t('editor.exitFullscreen') : t('editor.fullscreen')}
                className="h-8 w-8"
              >
                {isFullscreen ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </Button>

              {/* Close button */}
              <Button
                variant="ghost"
                size="icon"
                onClick={handleClose}
                title={t('common.close', 'Close')}
                className="h-8 w-8"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-hidden">
          {showPreview && isMarkdown ? (
            <ScrollArea className="h-full">
              <div className="prose prose-sm max-w-none px-8 py-6">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownPreviewComponents}>
                  {content}
                </ReactMarkdown>
              </div>
            </ScrollArea>
          ) : (
            <Editor
              height="100%"
              language={language}
              theme={monacoTheme}
              beforeMount={handleBeforeMount}
              value={content}
              onChange={(value) => setContent(value || '')}
              options={{
                minimap: { enabled: showMinimap },
                fontSize: 13,
                lineNumbers: 'on',
                automaticLayout: true,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
              }}
            />
          )}
        </div>

        {/* Footer with save/cancel */}
        <div className="flex items-center justify-between border-t border-border/50 px-6 py-3">
          <div className="text-xs text-muted-foreground">
            {isDirty && <span>{t('editor.modified', 'Modified')}</span>}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleClose}>
              <X className="mr-1 h-3.5 w-3.5" />
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!isDirty || saving}>
              {saving ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1 h-3.5 w-3.5" />
              )}
              {t('common.save', 'Save')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Renders a Mermaid diagram from source text
 */
function MermaidBlock({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    mermaid.initialize({ startOnLoad: false, theme: 'dark' });
    mermaid
      .render(`mermaid-${Math.random().toString(36).slice(2)}`, chart)
      .then(({ svg: renderedSvg }) => {
        if (!cancelled) setSvg(renderedSvg);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [chart]);

  if (error) {
    return (
      <pre className="overflow-auto rounded bg-red-950/30 p-3 text-xs text-red-400">{error}</pre>
    );
  }

  return (
    <div
      ref={containerRef}
      className="my-4 flex justify-center [&>svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * Custom markdown components with Mermaid support
 */
const markdownPreviewComponents: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    const lang = match?.[1];

    if (lang === 'mermaid') {
      return <MermaidBlock chart={String(children).trim()} />;
    }

    // Block code (inside <pre>)
    if (className) {
      return (
        <code className={cn('text-xs', className)} {...props}>
          {children}
        </code>
      );
    }

    // Inline code
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 text-xs" {...props}>
        {children}
      </code>
    );
  },
  pre({ children }) {
    return <pre className="overflow-auto rounded-md bg-muted/50 p-3 text-sm">{children}</pre>;
  },
};

/**
 * Extract file extension from path
 */
function getFileExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastDot > lastSlash) {
    return filePath.substring(lastDot + 1);
  }
  return '';
}

/**
 * Map file extension to Monaco language identifier
 */
function getMonacoLanguage(ext: string): string {
  const langMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    md: 'markdown',
    mdx: 'markdown',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    ps1: 'powershell',
    dockerfile: 'dockerfile',
    php: 'php',
    vue: 'vue',
    graphql: 'graphql',
  };
  return langMap[ext.toLowerCase()] || 'plaintext';
}
