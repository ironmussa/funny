import { Editor, type BeforeMount, type OnMount } from '@monaco-editor/react';
import {
  Maximize2,
  Minimize2,
  Eye,
  EyeOff,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  Code,
  Copy,
  FileCode,
  X,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';

import { MermaidBlock } from '@/components/MermaidBlock';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { api } from '@/lib/api';
import { rehypeMarkSearch } from '@/lib/rehype-mark-search';
import { cn } from '@/lib/utils';
import { useSettingsStore, EDITOR_FONT_SIZE_PX } from '@/stores/settings-store';

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
  const codeFontSizePx = EDITOR_FONT_SIZE_PX[useSettingsStore((s) => s.fontSize)];
  const [content, setContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [showMinimap, setShowMinimap] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const ext = getFileExtension(filePath);
  const language = getMonacoLanguage(ext);
  const isMarkdown = language === 'markdown';

  const [showPreview, setShowPreview] = useState(isMarkdown);
  const [copied, copy] = useCopyToClipboard();

  // When the dialog opens or the file changes, default markdown files to preview mode.
  useEffect(() => {
    if (open) setShowPreview(isMarkdown);
  }, [open, filePath, isMarkdown]);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  // Markdown preview search state
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const matchElementsRef = useRef<HTMLElement[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);

  // Debounce typing so the (expensive) DOM walk runs after a short pause.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(id);
  }, [searchQuery]);

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
        // Find widget
        'editorWidget.background': '#1e1e1e',
        'editorWidget.border': '#454545',
        'editorWidget.foreground': '#cccccc',
        'input.background': '#2a2a2a',
        'input.foreground': '#cccccc',
        'input.border': '#454545',
        'inputOption.activeBorder': '#007acc',
        'inputOption.activeBackground': '#007acc44',
        'inputOption.activeForeground': '#ffffff',
        focusBorder: '#007acc',
      },
    });

    // Configure compiler to understand JSX — must come before diagnostics
    const compilerOptions: import('monaco-editor').typescript.CompilerOptions = {
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

  // Ctrl+F → open Monaco find widget in code view, or inline search bar in markdown preview.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        if (showPreview && isMarkdown) {
          setSearchOpen(true);
          // Focus the search input on next tick (after render).
          requestAnimationFrame(() => {
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
          });
          return;
        }
        const editor = editorRef.current;
        if (editor) {
          editor.focus();
          editor.getAction('actions.find')?.run();
        }
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open, showPreview, isMarkdown]);

  // Reset search when leaving preview, closing dialog, or switching files.
  useEffect(() => {
    if (!open || !showPreview || !isMarkdown) {
      setSearchOpen(false);
      setSearchQuery('');
    }
  }, [open, showPreview, isMarkdown, filePath]);

  // After ReactMarkdown renders with the rehype plugin, collect the produced
  // <mark> elements so we can navigate (next/prev) and scroll to active.
  // No DOM mutation — the plugin baked the highlights into the AST.
  useEffect(() => {
    const container = previewContainerRef.current;
    if (!container) {
      matchElementsRef.current = [];
      setMatchCount(0);
      setCurrentMatch(0);
      return;
    }
    const query = searchOpen ? debouncedQuery.trim() : '';
    if (!query) {
      matchElementsRef.current = [];
      setMatchCount(0);
      setCurrentMatch(0);
      return;
    }
    const marks = Array.from(container.querySelectorAll<HTMLElement>('mark.md-search-match'));
    matchElementsRef.current = marks;
    setMatchCount(marks.length);
    setCurrentMatch(marks.length > 0 ? 1 : 0);
  }, [debouncedQuery, searchOpen, content, showPreview, isMarkdown]);

  // Style + scroll the active match.
  useEffect(() => {
    const marks = matchElementsRef.current;
    marks.forEach((m, i) => {
      if (i === currentMatch - 1) {
        m.dataset.active = 'true';
      } else {
        delete m.dataset.active;
      }
    });
    const active = marks[currentMatch - 1];
    if (active) {
      active.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [currentMatch, matchCount]);

  const goToNextMatch = useCallback(() => {
    setCurrentMatch((prev) => (matchCount === 0 ? 0 : (prev % matchCount) + 1));
  }, [matchCount]);

  const goToPrevMatch = useCallback(() => {
    setCurrentMatch((prev) => (matchCount === 0 ? 0 : prev <= 1 ? matchCount : prev - 1));
  }, [matchCount]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
  }, []);

  // Memoize the rendered markdown. Re-renders only when content or the (debounced)
  // search query changes — the rehype plugin bakes <mark> elements into the AST,
  // so React reconciles normally without imperative DOM mutation.
  const activeQuery = searchOpen ? debouncedQuery.trim() : '';
  const renderedMarkdown = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeMarkSearch, { query: activeQuery }]]}
        components={markdownPreviewComponents}
      >
        {content}
      </ReactMarkdown>
    ),
    [content, activeQuery],
  );

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className={cn(
          isFullscreen
            ? 'max-w-[100vw] max-h-[100vh] w-[100vw] h-[100vh] flex flex-col gap-0 p-0'
            : 'flex h-[85vh] w-[90vw] max-w-[850px] flex-col gap-0 p-0',
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
          {/* Copy file contents */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => copy(content)}
                disabled={!content}
                className="flex-shrink-0 text-muted-foreground"
                data-testid="editor-copy-content"
                aria-label={t('editor.copy', 'Copy')}
              >
                {copied ? <Check className="icon-base" /> : <Copy className="icon-base" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('editor.copy', 'Copy')}</TooltipContent>
          </Tooltip>
          {/* Markdown preview toggle */}
          {isMarkdown && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
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
                size="icon-sm"
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
                size="icon-sm"
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
            <div className="relative h-full">
              {searchOpen && (
                <div
                  className="absolute right-4 top-3 z-10 flex items-center gap-1 rounded-md border border-border bg-popover p-1 shadow-md"
                  data-testid="markdown-search-bar"
                >
                  <Input
                    ref={searchInputRef}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        closeSearch();
                      } else if (e.key === 'Enter') {
                        e.preventDefault();
                        if (e.shiftKey) goToPrevMatch();
                        else goToNextMatch();
                      }
                    }}
                    placeholder={t('editor.searchPlaceholder', 'Find')}
                    className="h-7 w-48 text-xs"
                    data-testid="markdown-search-input"
                  />
                  <span
                    className="min-w-[3rem] px-1 text-center text-xs tabular-nums text-muted-foreground"
                    data-testid="markdown-search-count"
                  >
                    {matchCount === 0 ? '0/0' : `${currentMatch}/${matchCount}`}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={goToPrevMatch}
                    disabled={matchCount === 0}
                    data-testid="markdown-search-prev"
                    aria-label={t('editor.searchPrev', 'Previous match')}
                  >
                    <ChevronUp className="icon-base" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={goToNextMatch}
                    disabled={matchCount === 0}
                    data-testid="markdown-search-next"
                    aria-label={t('editor.searchNext', 'Next match')}
                  >
                    <ChevronDown className="icon-base" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={closeSearch}
                    data-testid="markdown-search-close"
                    aria-label={t('editor.searchClose', 'Close search')}
                  >
                    <X className="icon-base" />
                  </Button>
                </div>
              )}
              <ScrollArea className="h-full">
                <div ref={previewContainerRef} className="prose prose-sm max-w-none px-8 py-6">
                  {renderedMarkdown}
                </div>
              </ScrollArea>
            </div>
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
                fontSize: codeFontSizePx,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                lineNumbers: 'on',
                automaticLayout: true,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                fixedOverflowWidgets: true,
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
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
