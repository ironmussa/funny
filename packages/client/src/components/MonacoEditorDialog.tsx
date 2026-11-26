import type { OnMount } from '@monaco-editor/react';
import type { editor as monacoEditor } from 'monaco-editor';
import { useTheme } from 'next-themes';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

import { HtmlPreview } from '@/components/HtmlPreview';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { toast } from '@/components/ui/toast';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { useResettableState } from '@/hooks/use-resettable-state';
import { api } from '@/lib/api';
import type { BlameHistoryEntry } from '@/lib/editor-blame-history';
import { isHtmlFile } from '@/lib/html-preview';
import { markdownProseClassName } from '@/lib/markdown-components';
import { isMarkdownFile } from '@/lib/markdown-file';
import { monacoThemeFor } from '@/lib/monaco-theme';
import { toRawFileSrc } from '@/lib/raw-file-src';
import { rehypeMarkSearch } from '@/lib/rehype-mark-search';
import { cn } from '@/lib/utils';
import { getVisualizerForFence, getVisualizerForFileExt } from '@/lib/visualizer-registry';
import { useSettingsStore, EDITOR_FONT_SIZE_PX } from '@/stores/settings-store';

import { getFileExtension, getMonacoLanguage } from './monaco-editor-dialog/editor-language';
import { EditorDialogHeader } from './monaco-editor-dialog/EditorDialogHeader';
import { FileHistorySidebar } from './monaco-editor-dialog/FileHistorySidebar';
import { useEditorBlame } from './monaco-editor-dialog/use-editor-blame';
import { useEditorSearch } from './monaco-editor-dialog/use-editor-search';

interface MonacoEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filePath: string;
  initialContent: string | null;
}

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
  const isMarkdown = isMarkdownFile(filePath);
  const isHtml = isHtmlFile(filePath);
  // Installed visualizers can also enable preview for other file types.
  const fileVisualizer = getVisualizerForFileExt(ext);
  const canPreview = isMarkdown || isHtml || !!fileVisualizer;
  // Raw-bytes URL for the current file — handed to binary visualizers (images,
  // Parquet, …) whose `source` text would be corrupt. Text visualizers ignore it.
  const rawFileSrc = toRawFileSrc(filePath);
  // A binary visualizer has no meaningful text view — lock to preview so the
  // code/preview toggle (which would show an empty Monaco) is hidden.
  const lockPreview = !!fileVisualizer?.contributes.binary;

  // When the dialog opens or the file changes, default previewable files to preview mode.
  const [showPreview, setShowPreview] = useResettableState(canPreview, [
    open,
    filePath,
    canPreview,
  ]);
  const [copied, copy] = useCopyToClipboard();

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const isDirty = content !== originalContent;
  const inCodeView = !(showPreview && canPreview);
  const {
    previewContainerRef,
    searchInputRef,
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    debouncedQuery,
    matchCount,
    currentMatch,
    caseSensitive,
    setCaseSensitive,
    wholeWord,
    setWholeWord,
    regex,
    setRegex,
    goToNextMatch,
    goToPrevMatch,
    closeSearch,
    detachEditor,
  } = useEditorSearch({
    open,
    content,
    inCodeView,
    htmlPreviewShown: showPreview && isHtml,
    editorRef,
  });
  const {
    blame,
    showBlame,
    setShowBlame,
    historyEntries,
    canShowHistory,
    showHistory,
    setHiddenHistoryFile,
    bindEditor,
  } = useEditorBlame({ open, filePath, content, inCodeView, editorRef, t });

  // Derive Monaco theme — monochrome (light) uses VS, everything else is dark-based
  const monacoTheme = monacoThemeFor(resolvedTheme);

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
    setHiddenHistoryFile(null);
    setSearchOpen(false);
    setSearchQuery('');
    onOpenChange(false);
  };

  const handleEditorMount: OnMount = useCallback(
    (editor) => {
      editorRef.current = editor;
      detachEditor();
      bindEditor(editor);

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
      // SAFETY: Monaco 0.55 text models carry the internal `tokenization.forceTokenization`;
      // both members are typed optional and called with `?.`, so a missing one is a no-op.
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
    },
    [bindEditor, detachEditor],
  );

  const revealHistoryEntry = useCallback(
    (entry: BlameHistoryEntry) => {
      const line = entry.ranges[0]?.startLine;
      if (!line) return;
      if (showPreview && canPreview && !lockPreview) {
        setShowPreview(false);
      }
      requestAnimationFrame(() => {
        const editor = editorRef.current;
        editor?.setPosition({ lineNumber: line, column: 1 });
        editor?.revealLineInCenterIfOutsideViewport(line);
        editor?.focus();
      });
    },
    [canPreview, lockPreview, setShowPreview, showPreview],
  );

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
        flush
        className={cn(
          isFullscreen
            ? 'max-w-[100vw] max-h-screen w-screen h-screen flex flex-col'
            : 'flex h-[85vh] w-[90vw] max-w-[1120px] flex-col',
          'overflow-hidden',
        )}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <EditorDialogHeader
          filePath={filePath}
          content={content}
          copied={copied}
          onCopy={() => copy(content)}
          toggles={{
            canPreview,
            lockPreview,
            showPreview,
            onTogglePreview: () => setShowPreview((value) => !value),
            inCodeView,
            hasBlame: !!blame && blame.hunks.length > 0,
            showBlame,
            onToggleBlame: () => setShowBlame((prev) => !prev),
            canShowHistory,
            showHistory,
            onToggleHistory: () =>
              setHiddenHistoryFile((prev) => (prev === filePath ? null : filePath)),
            showMinimap,
            onToggleMinimap: () => setShowMinimap((prev) => !prev),
          }}
          isFullscreen={isFullscreen}
          onToggleFullscreen={() => setIsFullscreen((prev) => !prev)}
        />

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="relative min-w-0 flex-1 overflow-hidden">
            {searchOpen && !(showPreview && isHtml) && (
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
                variant="overlay"
                className="absolute top-3 right-4 z-10"
              />
            )}
            {showPreview && isHtml ? (
              <HtmlPreview content={content} filePath={filePath} />
            ) : showPreview && isMarkdown ? (
              <ScrollArea className="h-full">
                <div ref={previewContainerRef} className={cn(markdownProseClassName, 'px-8 py-6')}>
                  {renderedMarkdown}
                </div>
              </ScrollArea>
            ) : showPreview && fileVisualizer ? (
              <fileVisualizer.Component source={content} src={rawFileSrc} fill />
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
          {showHistory && canShowHistory && (
            <FileHistorySidebar entries={historyEntries} onSelect={revealHistoryEntry} />
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
