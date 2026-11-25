import type { OnMount } from '@monaco-editor/react';
import type { editor as monacoEditor } from 'monaco-editor';
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';

type EditorInstance = Parameters<OnMount>[0];

const MONACO_WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/? \t\n';

interface MatchState {
  searchOpen: boolean;
  debouncedQuery: string;
  content: string;
  inCodeView: boolean;
  currentMatch: number;
  matchCount: number;
  setMatchCount: Dispatch<SetStateAction<number>>;
  setCurrentMatch: Dispatch<SetStateAction<number>>;
}

/**
 * Markdown preview search: collects the `<mark>` elements produced by the
 * rehype plugin so the search bar can navigate them, and styles the active one.
 */
export function useMarkdownSearch({
  searchOpen,
  debouncedQuery,
  content,
  inCodeView,
  currentMatch,
  matchCount,
  setMatchCount,
  setCurrentMatch,
}: MatchState) {
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const matchElementsRef = useRef<HTMLElement[]>([]);

  useEffect(() => {
    if (inCodeView) return;
    const query = searchOpen ? debouncedQuery.trim() : '';
    const marks = collectMarkdownMatches(previewContainerRef.current, query);
    matchElementsRef.current = marks;
    setMatchCount(marks.length);
    setCurrentMatch(firstMatchIndex(marks.length));
  }, [debouncedQuery, searchOpen, content, inCodeView, setMatchCount, setCurrentMatch]);

  // Style + scroll the active markdown match.
  useEffect(() => {
    if (inCodeView) return;
    showActiveMarkdownMatch(matchElementsRef.current, currentMatch);
  }, [currentMatch, matchCount, inCodeView]);

  // Switching to the code view: clear the preview's active match.
  useEffect(() => {
    if (!inCodeView) return;
    clearMarkdownActive(matchElementsRef.current);
    matchElementsRef.current = [];
  }, [inCodeView]);

  return { previewContainerRef };
}

interface MonacoSearchOptions extends MatchState {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  editorRef: RefObject<EditorInstance | null>;
}

/**
 * Monaco code view search: runs findMatches when the query / options / open
 * state change, then decorates the matches and scrolls to the active one.
 */
export function useMonacoSearch({
  searchOpen,
  debouncedQuery,
  content,
  inCodeView,
  currentMatch,
  matchCount,
  setMatchCount,
  setCurrentMatch,
  regex,
  caseSensitive,
  wholeWord,
  editorRef,
}: MonacoSearchOptions) {
  const monacoMatchesRef = useRef<monacoEditor.FindMatch[]>([]);
  const monacoDecorationsRef = useRef<monacoEditor.IEditorDecorationsCollection | null>(null);

  useEffect(() => {
    if (!inCodeView) return;
    const model = editorRef.current?.getModel();
    if (!model) return;
    const query = searchOpen ? debouncedQuery : '';
    if (!query) monacoDecorationsRef.current?.clear();
    const matches = findMonacoMatches(model, query, { regex, caseSensitive, wholeWord });
    monacoMatchesRef.current = matches;
    setMatchCount(matches.length);
    setCurrentMatch(firstMatchIndex(matches.length));
  }, [
    debouncedQuery,
    regex,
    caseSensitive,
    wholeWord,
    searchOpen,
    content,
    inCodeView,
    editorRef,
    setMatchCount,
    setCurrentMatch,
  ]);

  // Apply / update Monaco decorations and scroll to the active match.
  useEffect(() => {
    if (!inCodeView) return;
    const editor = editorRef.current;
    if (!editor) return;
    applyMatchDecorations(editor, monacoDecorationsRef, monacoMatchesRef.current, currentMatch);
  }, [currentMatch, matchCount, inCodeView, editorRef]);

  // Switching to the preview: clear the code view's decorations.
  useEffect(() => {
    if (inCodeView) return;
    monacoDecorationsRef.current?.clear();
    monacoMatchesRef.current = [];
  }, [inCodeView]);

  // Called from the editor's onMount: the decorations collection is bound to
  // the previous editor instance, so the next effect creates a fresh one.
  const detachEditor = useCallback(() => {
    monacoDecorationsRef.current = null;
  }, []);

  return { detachEditor };
}

function applyMatchDecorations(
  editor: EditorInstance,
  decorationsRef: RefObject<monacoEditor.IEditorDecorationsCollection | null>,
  matches: monacoEditor.FindMatch[],
  currentMatch: number,
): void {
  const decorations = matchDecorations(matches, currentMatch);
  if (!decorationsRef.current) {
    decorationsRef.current = editor.createDecorationsCollection(decorations);
  } else {
    decorationsRef.current.set(decorations);
  }
  const active = matches[currentMatch];
  if (active) {
    editor.revealRangeInCenterIfOutsideViewport(active.range);
  }
}

interface SearchOptions {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** Index of the first match, or `-1` when there is none. */
function firstMatchIndex(count: number): number {
  return count > 0 ? 0 : -1;
}

/** The `<mark>` elements the rehype search plugin produced, if a query is active. */
function collectMarkdownMatches(container: HTMLElement | null, query: string): HTMLElement[] {
  if (!container || !query) return [];
  return Array.from(container.querySelectorAll<HTMLElement>('mark.md-search-match'));
}

function clearMarkdownActive(marks: HTMLElement[]): void {
  marks.forEach((m) => delete m.dataset.active);
}

/** Flag the active markdown match and scroll it into view. */
function showActiveMarkdownMatch(marks: HTMLElement[], currentMatch: number): void {
  marks.forEach((m, i) => {
    if (i === currentMatch) m.dataset.active = 'true';
    else delete m.dataset.active;
  });
  const active = marks[currentMatch];
  if (active) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function findMonacoMatches(
  model: monacoEditor.ITextModel,
  query: string,
  { regex, caseSensitive, wholeWord }: SearchOptions,
): monacoEditor.FindMatch[] {
  if (!query) return [];
  try {
    return model.findMatches(
      query,
      false,
      regex,
      caseSensitive,
      wholeWord ? MONACO_WORD_SEPARATORS : null,
      false,
    );
  } catch {
    // Invalid regex — treat as no matches.
    return [];
  }
}

function matchDecorations(
  matches: monacoEditor.FindMatch[],
  currentMatch: number,
): monacoEditor.IModelDeltaDecoration[] {
  return matches.map((m, i) => ({
    range: m.range,
    options: {
      inlineClassName: i === currentMatch ? 'monaco-search-match-active' : 'monaco-search-match',
    },
  }));
}
