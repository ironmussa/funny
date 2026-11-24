import type { OnMount } from '@monaco-editor/react';
import type { editor as monacoEditor } from 'monaco-editor';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { useTranslation } from 'react-i18next';

import { useMinuteTick } from '@/hooks/use-minute-tick';
import { api } from '@/lib/api';
import type { BlameHunk, BlameResponse, FileHistoryEntry } from '@/lib/api/system';
import { createClientLogger } from '@/lib/client-logger';
import { buildFileHistoryEntries } from '@/lib/editor-blame-history';
import { timeAgo } from '@/lib/thread-utils';

type EditorInstance = Parameters<OnMount>[0];
type TFn = ReturnType<typeof useTranslation>['t'];

const blameLog = createClientLogger('blame');
const EMPTY_FILE_HISTORY: FileHistoryEntry[] = [];

interface UseEditorBlameOptions {
  open: boolean;
  filePath: string;
  content: string;
  inCodeView: boolean;
  editorRef: RefObject<EditorInstance | null>;
  t: TFn;
}

/**
 * Git blame (gutter + hover) and file history for the editor dialog.
 */
export function useEditorBlame({
  open,
  filePath,
  content,
  inCodeView,
  editorRef,
  t,
}: UseEditorBlameOptions) {
  const now = useMinuteTick();
  // ── Git blame (gutter + hover) ──────────────────────────────────────────────
  // Per-line commit attribution from `GET /files/blame`, rendered as injected
  // text in the left gutter. A single declarative effect (below) reconciles the
  // decorations from `blame` / `showBlame` / `inCodeView`; `editorNonce` bumps on
  // every editor (re)mount so that effect re-runs against the fresh instance.
  const [blame, setBlame] = useState<BlameResponse | null>(null);
  const [fileHistoryState, setFileHistoryState] = useState<{
    filePath: string;
    entries: FileHistoryEntry[];
  } | null>(null);
  // Shown by default once blame loads; the toolbar toggle hides it per file.
  const [showBlame, setShowBlame] = useState(true);
  const [hiddenHistoryFile, setHiddenHistoryFile] = useState<string | null>(null);
  const [editorNonce, setEditorNonce] = useState(0);
  // GitLens-style current-line blame: a single end-of-line `after` annotation on
  // the line the cursor is on. `currentLine` tracks the cursor; the collection is
  // owned by the editor (ownerId = editor id), which the view's injected-text
  // recompute requires. `editorNonce` rebuilds it on every editor (re)mount.
  const [currentLine, setCurrentLine] = useState(1);
  const blameDecorationsRef = useRef<monacoEditor.IEditorDecorationsCollection | null>(null);

  const fileHistory =
    fileHistoryState?.filePath === filePath ? fileHistoryState.entries : EMPTY_FILE_HISTORY;
  const historyEntries = useMemo(
    () => buildFileHistoryEntries({ blame, fileHistory, content }),
    [blame, fileHistory, content],
  );
  const canShowHistory = historyEntries.length > 0;
  const showHistory = hiddenHistoryFile !== filePath;

  // Called from the editor's onMount: binds the blame annotation to the new instance.
  const bindEditor = useCallback((editor: EditorInstance) => {
    // The decorations collection is bound to the previous editor instance —
    // drop it so the next effect creates a fresh one on this model.
    blameDecorationsRef.current = null;
    // Track the cursor line so the blame annotation follows it (GitLens-style).
    setCurrentLine(editor.getPosition()?.lineNumber ?? 1);
    editor.onDidChangeCursorPosition((e) => setCurrentLine(e.position.lineNumber));
    // Bump the nonce so the declarative blame effect re-runs against this
    // fresh editor instance (and repaints if blame is already loaded).
    setEditorNonce((n) => n + 1);
  }, []);

  // Fetch blame + file history whenever the open file changes. Failures
  // (untracked file, no repo, native module unavailable) are non-fatal.
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
    setFileHistoryState({ filePath, entries: [] });
    void api.getFileBlame(filePath).then((res) => {
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
    void api.getFileHistory(filePath).then((res) => {
      if (cancelled) return;
      if (res.isOk()) {
        setFileHistoryState({ filePath, entries: res.value });
      } else {
        blameLog.warn('file history fetch failed', { filePath, error: res.error.message });
        setFileHistoryState({ filePath, entries: [] });
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
    const decorations = buildCurrentLineBlameDecoration(line, endColumn, blame, t, now);
    if (blameDecorationsRef.current) {
      blameDecorationsRef.current.set(decorations);
    } else {
      blameDecorationsRef.current = editor.createDecorationsCollection(decorations);
    }
    blameLog.info('blame render', { line: currentLine, count: decorations.length });
  }, [blame, showBlame, inCodeView, currentLine, content, editorNonce, t, now, editorRef]);

  return {
    blame,
    showBlame,
    setShowBlame,
    historyEntries,
    canShowHistory,
    showHistory,
    setHiddenHistoryFile,
    bindEditor,
  };
}

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
  t: TFn,
  now: number,
): monacoEditor.IModelDeltaDecoration[] {
  const hunk = hunkForLine(blame, line);
  const relativeLabel = hunk ? timeAgo(hunk.authoredAt, t, now) : t('time.now', 'now');
  const label = hunk
    ? `${hunk.author}, ${relativeLabel} • ${hunk.summary}`
    : 'You • Uncommitted changes';
  const hoverMessage = hunk
    ? {
        value: `**${escapeMarkdown(hunk.summary)}**\n\n${escapeMarkdown(hunk.author)} • ${relativeLabel}\n\n\`${hunk.shortHash}\``,
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
