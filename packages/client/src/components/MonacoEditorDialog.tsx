import { Editor, type BeforeMount, type OnMount } from '@monaco-editor/react';
import {
  Maximize2,
  Minimize2,
  Eye,
  EyeOff,
  BookOpen,
  Check,
  Code,
  Copy,
  FileCode,
} from 'lucide-react';
import type { editor as monacoEditor } from 'monaco-editor';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';

import '@/lib/monaco-setup';
import { MermaidBlock } from '@/components/MermaidBlock';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
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

const MONACO_WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/? \t\n';

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

  // Unified search state — used by both markdown preview and Monaco code view.
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const matchElementsRef = useRef<HTMLElement[]>([]);
  const monacoMatchesRef = useRef<monacoEditor.FindMatch[]>([]);
  const monacoDecorationsRef = useRef<monacoEditor.IEditorDecorationsCollection | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  // 0-based index of the currently focused match. `-1` means no active match.
  const [currentMatch, setCurrentMatch] = useState(-1);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);

  // Debounce typing so the (expensive) DOM walk / findMatches runs after a short pause.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 200);
    return () => clearTimeout(id);
  }, [searchQuery]);

  const isDirty = content !== originalContent;
  const inCodeView = !(showPreview && isMarkdown);

  // Derive Monaco theme — monochrome (light) uses VS, everything else is dark-based
  const monacoTheme = resolvedTheme === 'monochrome' ? 'vs' : 'funny-dark';

  const handleBeforeMount: BeforeMount = (monaco) => {
    monaco.editor.defineTheme('funny-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#000000',
        'editorGutter.background': '#000000',
        'minimap.background': '#0a0a0a',
        focusBorder: '#007acc',
      },
    });

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
    // The decorations collection is bound to the previous editor instance — drop it
    // so the next search effect creates a fresh one on this model.
    monacoDecorationsRef.current = null;
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
  }, []);

  // Ctrl+F → open the unified search bar (both code and markdown views).
  // Capture phase + preventDefault prevents Monaco's built-in find widget from opening.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
        requestAnimationFrame(() => {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        });
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [open]);

  // Reset search when the dialog closes or the file changes.
  useEffect(() => {
    if (!open) {
      setSearchOpen(false);
      setSearchQuery('');
    }
  }, [open, filePath]);

  // ── Markdown preview search ─────────────────────────────────────────────────
  // Collect <mark> elements produced by the rehype plugin so we can navigate.
  useEffect(() => {
    if (inCodeView) return;
    const container = previewContainerRef.current;
    if (!container) {
      matchElementsRef.current = [];
      setMatchCount(0);
      setCurrentMatch(-1);
      return;
    }
    const query = searchOpen ? debouncedQuery.trim() : '';
    if (!query) {
      matchElementsRef.current = [];
      setMatchCount(0);
      setCurrentMatch(-1);
      return;
    }
    const marks = Array.from(container.querySelectorAll<HTMLElement>('mark.md-search-match'));
    matchElementsRef.current = marks;
    setMatchCount(marks.length);
    setCurrentMatch(marks.length > 0 ? 0 : -1);
  }, [debouncedQuery, searchOpen, content, inCodeView]);

  // Style + scroll the active markdown match.
  useEffect(() => {
    if (inCodeView) return;
    const marks = matchElementsRef.current;
    marks.forEach((m, i) => {
      if (i === currentMatch) m.dataset.active = 'true';
      else delete m.dataset.active;
    });
    const active = marks[currentMatch];
    if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentMatch, matchCount, inCodeView]);

  // ── Monaco code view search ─────────────────────────────────────────────────
  // Run findMatches when the query / options / open state change.
  useEffect(() => {
    if (!inCodeView) return;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;

    const query = searchOpen ? debouncedQuery : '';
    if (!query) {
      monacoDecorationsRef.current?.clear();
      monacoMatchesRef.current = [];
      setMatchCount(0);
      setCurrentMatch(-1);
      return;
    }

    let matches: monacoEditor.FindMatch[] = [];
    try {
      matches = model.findMatches(
        query,
        false,
        regex,
        caseSensitive,
        wholeWord ? MONACO_WORD_SEPARATORS : null,
        false,
      );
    } catch {
      // Invalid regex — treat as no matches.
      matches = [];
    }
    monacoMatchesRef.current = matches;
    setMatchCount(matches.length);
    setCurrentMatch(matches.length > 0 ? 0 : -1);
  }, [debouncedQuery, regex, caseSensitive, wholeWord, searchOpen, content, inCodeView]);

  // Apply / update Monaco decorations and scroll to the active match.
  useEffect(() => {
    if (!inCodeView) return;
    const editor = editorRef.current;
    if (!editor) return;
    const matches = monacoMatchesRef.current;

    const decorations: monacoEditor.IModelDeltaDecoration[] = matches.map((m, i) => ({
      range: m.range,
      options: {
        inlineClassName: i === currentMatch ? 'monaco-search-match-active' : 'monaco-search-match',
      },
    }));

    if (!monacoDecorationsRef.current) {
      monacoDecorationsRef.current = editor.createDecorationsCollection(decorations);
    } else {
      monacoDecorationsRef.current.set(decorations);
    }

    const active = matches[currentMatch];
    if (active) {
      editor.revealRangeInCenterIfOutsideViewport(active.range);
    }
  }, [currentMatch, matchCount, inCodeView]);

  // Switching between preview / code: clear the other view's decorations.
  useEffect(() => {
    if (inCodeView) {
      matchElementsRef.current.forEach((m) => delete m.dataset.active);
      matchElementsRef.current = [];
    } else {
      monacoDecorationsRef.current?.clear();
      monacoMatchesRef.current = [];
    }
    // Re-trigger the appropriate effect by nudging state.
    if (searchOpen && debouncedQuery) {
      setMatchCount(0);
      setCurrentMatch(-1);
    }
    // Intentionally only react to view changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inCodeView]);

  const goToNextMatch = useCallback(() => {
    setCurrentMatch((prev) => (matchCount === 0 ? -1 : (prev + 1) % matchCount));
  }, [matchCount]);

  const goToPrevMatch = useCallback(() => {
    setCurrentMatch((prev) => (matchCount === 0 ? -1 : (prev - 1 + matchCount) % matchCount));
  }, [matchCount]);

  // Memoize the rendered markdown. Re-renders only when content or the (debounced)
  // search query changes — the rehype plugin bakes <mark> elements into the AST.
  const activeQuery = searchOpen && !inCodeView ? debouncedQuery.trim() : '';
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

  // Markdown highlighting only does case-insensitive substring matches; hide
  // the toggles in preview mode where they wouldn't take effect.
  const showAdvancedToggles = inCodeView;

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

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {searchOpen && (
            <SearchBar
              query={searchQuery}
              onQueryChange={setSearchQuery}
              totalMatches={matchCount}
              currentIndex={currentMatch}
              onNext={goToNextMatch}
              onPrev={goToPrevMatch}
              onClose={closeSearch}
              placeholder={t('editor.searchPlaceholder', 'Find')}
              showIcon={false}
              autoFocus
              inputRef={searchInputRef}
              caseSensitive={showAdvancedToggles ? caseSensitive : undefined}
              onCaseSensitiveChange={showAdvancedToggles ? setCaseSensitive : undefined}
              wholeWord={showAdvancedToggles ? wholeWord : undefined}
              onWholeWordChange={showAdvancedToggles ? setWholeWord : undefined}
              regex={showAdvancedToggles ? regex : undefined}
              onRegexChange={showAdvancedToggles ? setRegex : undefined}
              testIdPrefix="editor-search"
              className="absolute right-4 top-3 z-10 rounded-md border border-border bg-popover px-2 py-1 shadow-md"
            />
          )}
          {showPreview && isMarkdown ? (
            <ScrollArea className="h-full">
              <div ref={previewContainerRef} className="prose prose-sm max-w-none px-8 py-6">
                {renderedMarkdown}
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

const markdownPreviewComponents: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    const lang = match?.[1];

    if (lang === 'mermaid') {
      return <MermaidBlock chart={String(children).trim()} />;
    }

    if (className) {
      return (
        <code className={cn('text-xs', className)} {...props}>
          {children}
        </code>
      );
    }

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

function getFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

function getFileExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastDot > lastSlash) {
    return filePath.substring(lastDot + 1);
  }
  return '';
}

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
