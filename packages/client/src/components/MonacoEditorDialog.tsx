import type { OnMount } from '@monaco-editor/react';
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
  GitBranch,
} from 'lucide-react';
import type { editor as monacoEditor } from 'monaco-editor';
import { useTheme } from 'next-themes';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
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
import { SearchBar } from '@/components/ui/search-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { api } from '@/lib/api';
import type { BlameHunk, BlameResponse } from '@/lib/api/system';
import { createClientLogger } from '@/lib/client-logger';
import { markdownProseClassName } from '@/lib/markdown-components';
import { rehypeMarkSearch } from '@/lib/rehype-mark-search';
import { cn } from '@/lib/utils';
import { getVisualizerForFence, getVisualizerForFileExt } from '@/lib/visualizer-registry';
import { useSettingsStore, EDITOR_FONT_SIZE_PX } from '@/stores/settings-store';

interface MonacoEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  initialContent: string | null;
}

const MONACO_WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/? \t\n';

const blameLog = createClientLogger('blame');

const MonacoCodeView = lazy(() =>
  import('@/components/MonacoCodeView').then((m) => ({ default: m.MonacoCodeView })),
);

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
  const language = getMonacoLanguage(ext, filePath);
  const isMarkdown = language === 'markdown';
  // A visualizer registered for this file's extension (e.g. an installed CSV
  // plugin) also enables preview. Built-ins claim no file extensions, so for
  // them `canPreview` reduces to `isMarkdown` (no behavior change).
  const fileVisualizer = getVisualizerForFileExt(ext);
  const canPreview = isMarkdown || !!fileVisualizer;

  const [showPreview, setShowPreview] = useState(canPreview);
  const [copied, copy] = useCopyToClipboard();

  // When the dialog opens or the file changes, default previewable files to preview mode.
  useEffect(() => {
    if (open) setShowPreview(canPreview);
  }, [open, filePath, canPreview]);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  // Unified search state — used by both markdown preview and Monaco code view.
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const matchElementsRef = useRef<HTMLElement[]>([]);
  const monacoMatchesRef = useRef<monacoEditor.FindMatch[]>([]);
  const monacoDecorationsRef = useRef<monacoEditor.IEditorDecorationsCollection | null>(null);

  // ── Git blame (gutter + hover) ──────────────────────────────────────────────
  // Per-line commit attribution from `GET /files/blame`, rendered as injected
  // text in the left gutter. A single declarative effect (below) reconciles the
  // decorations from `blame` / `showBlame` / `inCodeView`; `editorNonce` bumps on
  // every editor (re)mount so that effect re-runs against the fresh instance.
  const [blame, setBlame] = useState<BlameResponse | null>(null);
  // Shown by default once blame loads; the toolbar toggle hides it per file.
  const [showBlame, setShowBlame] = useState(true);
  const [editorNonce, setEditorNonce] = useState(0);
  // GitLens-style current-line blame: a single end-of-line `after` annotation on
  // the line the cursor is on. `currentLine` tracks the cursor; the collection is
  // owned by the editor (ownerId = editor id), which the view's injected-text
  // recompute requires. `editorNonce` rebuilds it on every editor (re)mount.
  const [currentLine, setCurrentLine] = useState(1);
  const blameDecorationsRef = useRef<monacoEditor.IEditorDecorationsCollection | null>(null);

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
  const inCodeView = !(showPreview && canPreview);

  // Derive Monaco theme — monochrome (light) uses VS, everything else is dark-based
  const monacoTheme = resolvedTheme === 'monochrome' ? 'vs' : 'funny-dark';

  // Initialize the editor buffer synchronously, DURING render — not in an
  // effect. This guarantees Monaco's <Editor> mounts with the real content
  // already in place, so tokenization runs as part of the initial `create`
  // pass. If we set it from an effect, the editor first mounts empty ('') and
  // receives the content a frame later via setValue, which re-tokenizes AFTER
  // the text is already painted — that's the "plain text → highlight pops in"
  // flash. Setting state during render is React's supported "adjust state when
  // a prop changes" pattern: the guards below go false once applied (filePath
  // matches loadedFor), so it cannot loop. `initialContent` is delivered
  // atomically with `open` by the store, so it is non-null when open flips.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (open && initialContent != null && filePath !== loadedFor) {
    setContent(initialContent);
    setOriginalContent(initialContent);
    setLoadedFor(filePath);
  } else if (!open && loadedFor !== null) {
    setLoadedFor(null);
  }

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
    // The decorations collections are bound to the previous editor instance —
    // drop them so the next effect creates fresh ones on this model.
    monacoDecorationsRef.current = null;
    blameDecorationsRef.current = null;
    // Track the cursor line so the blame annotation follows it (GitLens-style).
    setCurrentLine(editor.getPosition()?.lineNumber ?? 1);
    editor.onDidChangeCursorPosition((e) => setCurrentLine(e.position.lineNumber));
    // Bump the nonce so the declarative blame effect re-runs against this
    // fresh editor instance (and repaints if blame is already loaded).
    setEditorNonce((n) => n + 1);

    // Synchronously tokenize the initial viewport before the browser paints.
    // Monaco 0.55 tokenizes lazily in the background, so the first painted frame
    // would otherwise show uncolored (single-foreground) text and "pop in" the
    // syntax colors a frame later. `onMount` runs in the same task as
    // `editor.create`, before the browser's first paint, so forcing tokenization
    // here means that first frame is already highlighted. `forceTokenization` is
    // the same internal model API that `monaco.editor.colorize` relies on — it's
    // stable but absent from the public d.ts, hence the narrow cast. Capped so
    // huge files don't block on whole-document tokenization; the rest streams in
    // lazily as the user scrolls.
    const model = editor.getModel() as
      | (monacoEditor.ITextModel & {
          tokenization?: { forceTokenization?: (lineNumber: number) => void };
        })
      | null;
    if (model) {
      const lastVisible = editor.getVisibleRanges().at(-1)?.endLineNumber ?? 0;
      const target = Math.min(model.getLineCount(), Math.max(lastVisible, 100));
      model.tokenization?.forceTokenization?.(target);
    }
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
  }, []);

  // Fetch blame whenever the open file changes. Failures (untracked file, no
  // repo, native module unavailable) are non-fatal: we just clear blame so the
  // gutter renders nothing.
  useEffect(() => {
    // LATCH: never null blame here. The dialog's `open`/`filePath` flip to
    // falsy transiently (Radix fires onOpenChange(false) during the active
    // thread's re-renders, then it reopens), and nulling on every such flip
    // wiped the gutter. We keep the last blame and only replace it once a new
    // fetch resolves; closing for real unmounts the editor so it doesn't matter.
    if (!open || !filePath) {
      blameLog.info('blame fetch effect: skip (latched)', { open, filePath });
      return;
    }
    blameLog.info('blame fetch effect', { open, filePath });
    let cancelled = false;
    api.getFileBlame(filePath).then((res) => {
      if (cancelled) return;
      if (res.isOk()) {
        blameLog.info('blame loaded', {
          filePath,
          hunks: res.value.hunks.length,
          blamedLineCount: res.value.blamedLineCount,
        });
        setBlame(res.value);
      } else {
        blameLog.warn('blame fetch failed', { filePath, error: res.error.message });
        setBlame(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, filePath]);

  // GitLens-style current-line blame: reconcile a single end-of-line annotation
  // on the cursor's line. Re-runs on cursor move (`currentLine`), data/visibility
  // changes, and editor (re)mount (`editorNonce`). The collection is owned by the
  // editor (ownerId = editor id), which the view's injected-text recompute needs.
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    if (!inCodeView || !showBlame || !blame) {
      blameDecorationsRef.current?.clear();
      return;
    }
    const lineCount = model.getLineCount();
    const line = Math.min(Math.max(currentLine, 1), lineCount);
    const endColumn = model.getLineMaxColumn(line);
    const decorations = buildCurrentLineBlameDecoration(line, endColumn, blame);
    if (blameDecorationsRef.current) {
      blameDecorationsRef.current.set(decorations);
    } else {
      blameDecorationsRef.current = editor.createDecorationsCollection(decorations);
    }
    blameLog.info('blame render', { line: currentLine, count: decorations.length });
  }, [blame, showBlame, inCodeView, currentLine, content, editorNonce]);

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
        // Security L1: sanitize before the search-mark plugin runs so that the
        // sanitizer cannot strip the <mark> elements injected by
        // `rehypeMarkSearch` (which it would, since `mark` is not in the
        // default safelist). Order matters: sanitize → then mark.
        rehypePlugins={[rehypeSanitize, [rehypeMarkSearch, { query: activeQuery }]]}
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
            ? 'max-w-[100vw] max-h-screen w-screen h-screen flex flex-col gap-0 p-0'
            : 'flex h-[85vh] w-[90vw] max-w-[850px] flex-col gap-0 p-0',
          'overflow-hidden',
        )}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="border-border shrink-0 overflow-hidden border-b px-4 py-3">
          <DialogTitle className="flex min-w-0 items-center gap-2 overflow-hidden font-mono text-sm">
            <FileCode className="icon-base shrink-0" />
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
                className="text-muted-foreground shrink-0"
                data-testid="editor-copy-content"
                aria-label={t('editor.copy', 'Copy')}
              >
                {copied ? <Check className="icon-base" /> : <Copy className="icon-base" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('editor.copy', 'Copy')}</TooltipContent>
          </Tooltip>
          {canPreview && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowPreview((prev) => !prev)}
                  className="text-muted-foreground shrink-0"
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
          {inCodeView && blame && blame.hunks.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowBlame((prev) => !prev)}
                  className={cn(
                    'shrink-0',
                    showBlame ? 'text-foreground' : 'text-muted-foreground',
                  )}
                  data-testid="editor-toggle-blame"
                >
                  <GitBranch className="icon-base" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {showBlame
                  ? t('editor.hideBlame', 'Hide blame')
                  : t('editor.showBlame', 'Show blame')}
              </TooltipContent>
            </Tooltip>
          )}
          {inCodeView && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowMinimap((prev) => !prev)}
                  className="text-muted-foreground shrink-0"
                  data-testid="editor-toggle-minimap"
                >
                  {showMinimap ? <EyeOff className="icon-base" /> : <Eye className="icon-base" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {showMinimap ? t('editor.hideMinimap') : t('editor.showMinimap')}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setIsFullscreen((prev) => !prev)}
                className="text-muted-foreground shrink-0"
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
              className="border-border bg-popover absolute top-3 right-4 z-10 rounded-md border px-2 py-1 shadow-md"
            />
          )}
          {showPreview && isMarkdown ? (
            <ScrollArea className="h-full">
              <div ref={previewContainerRef} className={cn(markdownProseClassName, 'px-8 py-6')}>
                {renderedMarkdown}
              </div>
            </ScrollArea>
          ) : showPreview && fileVisualizer ? (
            <fileVisualizer.Component source={content} fill />
          ) : (
            <Suspense fallback={<div className="h-full" />}>
              <MonacoCodeView
                language={language}
                theme={monacoTheme}
                content={content}
                onChange={setContent}
                onMount={handleEditorMount}
                showMinimap={showMinimap}
                codeFontSizePx={codeFontSizePx}
                wordWrap={showBlame && blame ? 'off' : 'on'}
              />
            </Suspense>
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

    const visualizer = lang ? getVisualizerForFence(lang) : undefined;
    if (visualizer) {
      const Visualizer = visualizer.Component;
      return <Visualizer source={String(children).trim()} />;
    }

    if (className) {
      return (
        <code className={cn('text-xs', className)} {...props}>
          {children}
        </code>
      );
    }

    return (
      <code className="bg-muted rounded px-1.5 py-0.5 text-xs" {...props}>
        {children}
      </code>
    );
  },
  pre({ children }) {
    return <pre className="bg-muted/50 overflow-auto rounded-md p-3 text-sm">{children}</pre>;
  },
};

/** Neutralize the few markdown chars that would break a hover tooltip. */
function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_[\]]/g, '\\$&');
}

/** Find the hunk (commit) that introduced a given 1-based line, if any. */
function hunkForLine(blame: BlameResponse, line: number): BlameHunk | undefined {
  for (const hunk of blame.hunks) {
    if (line >= hunk.startLine && line < hunk.startLine + hunk.lineCount) return hunk;
  }
  return undefined;
}

/**
 * Build the single GitLens-style blame annotation for the cursor's line: an
 * end-of-line `after` injection (gray, padded off the code) attributing the line
 * to the commit that introduced it. Lines past the blamed (HEAD) range — added
 * in the working copy — show "Uncommitted".
 *
 * Note: blame is computed against HEAD, so on a heavily-modified file the
 * line→commit mapping can drift (gix blames committed history, not the worktree).
 */
function buildCurrentLineBlameDecoration(
  line: number,
  endColumn: number,
  blame: BlameResponse,
): monacoEditor.IModelDeltaDecoration[] {
  const hunk = hunkForLine(blame, line);
  const label = hunk
    ? `${hunk.author}, ${hunk.relativeDate} • ${hunk.summary}`
    : 'You • Uncommitted changes';
  const hoverMessage = hunk
    ? {
        value: `**${escapeMarkdown(hunk.summary)}**\n\n${escapeMarkdown(hunk.author)} • ${hunk.relativeDate}\n\n\`${hunk.shortHash}\``,
      }
    : { value: '_Not committed yet_' };
  return [
    {
      // Collapsed range at end-of-line; `after` injects the annotation there.
      // `showIfCollapsed` is REQUIRED — Monaco filters injected text on empty
      // ranges otherwise (getAllInjectedText drops `range.isEmpty()` decorations).
      range: { startLineNumber: line, startColumn: endColumn, endLineNumber: line, endColumn },
      options: {
        after: {
          content: `        ${label}`,
          inlineClassName: 'monaco-blame-inline',
        },
        hoverMessage,
        showIfCollapsed: true,
      },
    },
  ];
}

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

function getMonacoLanguage(ext: string, filePath?: string): string {
  if (filePath) {
    const name = getFileName(filePath);
    if (/^\.env(\..+)?$/.test(name) || name === '.env') return 'dotenv';
  }
  const langMap: Record<string, string> = {
    env: 'dotenv',
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
