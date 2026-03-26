import { Editor, type BeforeMount, type OnMount } from '@monaco-editor/react';
import { Maximize2, Minimize2, Eye, EyeOff, BookOpen, Code, FileCode } from 'lucide-react';
import mermaid from 'mermaid';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
  const [showMinimap, setShowMinimap] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const ext = getFileExtension(filePath);
  const language = getMonacoLanguage(ext);
  const isMarkdown = language === 'markdown';

  const [showPreview, setShowPreview] = useState(isMarkdown);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const isDirty = content !== originalContent;

  // Derive Monaco theme — monochrome (light) uses VS, everything else is dark-based
  const monacoTheme = resolvedTheme === 'monochrome' ? 'vs' : 'funny-dark';

  // Define custom dark theme and disable TS/JS diagnostics (no tsconfig / node_modules in browser)
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

    // Configure compiler to understand JSX — must come before diagnostics
    const compilerOptions: import('monaco-editor').languages.typescript.CompilerOptions = {
      jsx: monaco.languages.typescript.JsxEmit.React,
      jsxFactory: 'React.createElement',
      reactNamespace: 'React',
      allowJs: true,
      allowNonTsExtensions: true,
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      noEmit: true,
    };
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
    monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);

    // Keep syntax validation (good highlighting) but disable semantic (unresolved imports, types)
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
  };

  // Set initial content when dialog opens
  useEffect(() => {
    if (!open || !initialContent) return;
    setContent(initialContent);
    setOriginalContent(initialContent);
  }, [open, initialContent]);

  // Auto-save with debounce (1s after last keystroke)
  const autoSaveRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!open || !isDirty) return;
    clearTimeout(autoSaveRef.current);
    autoSaveRef.current = setTimeout(async () => {
      const result = await api.writeFile(filePath, content);
      if (result.isOk()) {
        setOriginalContent(content);
        toast.success(t('editor.saved', 'File saved'));
      } else {
        toast.error(t('editor.failedToSave', 'Failed to save file'), {
          description: result.error.message,
        });
      }
    }, 1000);
    return () => clearTimeout(autoSaveRef.current);
  }, [open, isDirty, filePath, content, t]);

  const handleClose = () => {
    onOpenChange(false);
  };

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  // Ctrl+F → open Monaco find widget
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        const editor = editorRef.current;
        if (editor) {
          editor.focus();
          editor.getAction('actions.find')?.run();
        }
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className={cn(
          isFullscreen
            ? 'max-w-[100vw] max-h-[100vh] w-[100vw] h-[100vh] flex flex-col gap-0 p-0'
            : 'flex h-[85vh] w-[90vw] max-w-[90vw] flex-col gap-0 p-0',
          'overflow-hidden',
        )}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="flex-shrink-0 overflow-hidden border-b border-border px-4 py-3">
          <DialogTitle className="flex min-w-0 items-center gap-2 overflow-hidden font-mono text-sm">
            <FileCode className="icon-base flex-shrink-0" />
            <span
              className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              style={{ direction: 'rtl', textAlign: 'left' }}
            >
              {filePath}
            </span>
          </DialogTitle>
          {/* Markdown preview toggle */}
          {isMarkdown && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setShowPreview((prev) => !prev)}
                  className="flex-shrink-0 text-muted-foreground"
                  data-testid="editor-toggle-preview"
                >
                  {showPreview ? (
                    <Code className="icon-base" />
                  ) : (
                    <BookOpen className="icon-base" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {showPreview
                  ? t('editor.showCode', 'Show code')
                  : t('editor.showPreview', 'Show preview')}
              </TooltipContent>
            </Tooltip>
          )}
          {/* Minimap toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setShowMinimap((prev) => !prev)}
                className="flex-shrink-0 text-muted-foreground"
                data-testid="editor-toggle-minimap"
              >
                {showMinimap ? <EyeOff className="icon-base" /> : <Eye className="icon-base" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {showMinimap ? t('editor.hideMinimap') : t('editor.showMinimap')}
            </TooltipContent>
          </Tooltip>
          {/* Fullscreen toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setIsFullscreen((prev) => !prev)}
                className="flex-shrink-0 text-muted-foreground"
                data-testid="editor-toggle-fullscreen"
              >
                {isFullscreen ? (
                  <Minimize2 className="icon-base" />
                ) : (
                  <Maximize2 className="icon-base" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isFullscreen ? t('editor.exitFullscreen') : t('editor.fullscreen')}
            </TooltipContent>
          </Tooltip>
          <DialogDescription className="sr-only">
            {t('editor.dialogDescription', `Editor for ${getFileName(filePath)}`)}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden">
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
              onMount={handleEditorMount}
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
 * Extract file name from path
 */
function getFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

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
