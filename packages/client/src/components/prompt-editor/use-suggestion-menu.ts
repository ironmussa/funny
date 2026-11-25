import type { useEditor } from '@tiptap/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { SuggestionItem, SuggestionMenuType } from './types';

type PromptTiptapEditor = ReturnType<typeof useEditor>;

/**
 * Refs for suggestion state accessed inside closures captured at editor
 * creation time. The caller keeps them current (in a layout effect).
 */
function useSuggestionStateRefs(
  items: SuggestionItem[],
  type: SuggestionMenuType | null,
  query: string,
  index: number,
) {
  const suggestionItemsRef = useRef(items);
  const suggestionTypeRef = useRef(type);
  const suggestionQueryRef = useRef(query);
  const suggestionIndexRef = useRef(index);
  return { suggestionItemsRef, suggestionTypeRef, suggestionQueryRef, suggestionIndexRef };
}

/**
 * The single, shared suggestion menu used by every trigger (@, /, #, >>):
 * its state, the refs TipTap's suggestion callbacks read, and the helpers
 * the per-trigger configs share.
 */
export function useSuggestionMenu() {
  // ── Suggestion state (shared for both @ and /) ──
  const [suggestionType, setSuggestionType] = useState<SuggestionMenuType | null>(null);
  const [suggestionItems, setSuggestionItems] = useState<SuggestionItem[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionTruncated, setSuggestionTruncated] = useState(false);
  const [suggestionQuery, setSuggestionQuery] = useState('');
  const [suggestionRect, setSuggestionRect] = useState<(() => DOMRect | null) | null>(null);
  const suggestionCommandRef = useRef<((props: Record<string, unknown>) => void) | null>(null);

  const { suggestionItemsRef, suggestionTypeRef, suggestionQueryRef, suggestionIndexRef } =
    useSuggestionStateRefs(suggestionItems, suggestionType, suggestionQuery, suggestionIndex);

  useLayoutEffect(() => {
    suggestionItemsRef.current = suggestionItems;
    suggestionTypeRef.current = suggestionType;
    suggestionQueryRef.current = suggestionQuery;
    suggestionIndexRef.current = suggestionIndex;
  }, [
    suggestionIndex,
    suggestionItems,
    suggestionQuery,
    suggestionType,
    suggestionItemsRef,
    suggestionTypeRef,
    suggestionQueryRef,
    suggestionIndexRef,
  ]);

  // Track the trigger position so we can read the full query (@ to next space/EOL)
  // regardless of caret position
  const triggerPosRef = useRef<number | null>(null);
  const editorRef = useRef<PromptTiptapEditor>(null);

  /**
   * Read the full text after a trigger character (@, /, #, or >) up to the next
   * whitespace or end of the text node, regardless of caret position.
   * Falls back to TipTap's query if the editor isn't available.
   */
  const getFullQuery = useCallback((tiptapQuery: string): string => {
    const ed = editorRef.current;
    const triggerFrom = triggerPosRef.current;
    if (!ed || triggerFrom == null) return tiptapQuery;

    try {
      const doc = ed.state.doc;
      // triggerFrom is the position of the trigger char (@ or /), text starts after it
      const textStart = triggerFrom + 1;
      const docSize = doc.content.size;
      if (textStart >= docSize) return tiptapQuery;

      // Read text from after the trigger to end of document
      const textAfterTrigger = doc.textBetween(textStart, docSize, '\n');
      // Take everything up to the first whitespace
      const match = textAfterTrigger.match(/^(\S*)/);
      return match ? match[1] : tiptapQuery;
    } catch {
      return tiptapQuery;
    }
  }, []);

  const applySuggestionItems = useCallback(
    (items: SuggestionItem[]) => {
      const previousItems = suggestionItemsRef.current;
      const changed =
        previousItems.length !== items.length ||
        previousItems.some((item, index) => item.id !== items[index]?.id);

      suggestionItemsRef.current = items;
      setSuggestionItems(items);
      if (changed) setSuggestionIndex(0);
    },
    [suggestionItemsRef],
  );

  // Every trigger (@, /, #, >>) renders the same popup off one shared
  // `suggestionType`/`suggestionIndex` pair, and more than one TipTap suggestion
  // plugin can be active at the same time. So a plugin claims keys only while
  // its own menu is the one on screen — otherwise two plugins would move the
  // shared selected index for a single keypress.
  /** Closes the open suggestion menu and forgets where it was triggered. */
  const closeSuggestions = useCallback(() => {
    triggerPosRef.current = null;
    setSuggestionType(null);
    setSuggestionItems([]);
    setSuggestionQuery('');
    setSuggestionLoading(false);
    setSuggestionTruncated(false);
  }, []);

  const makeSuggestionKeyDown = useCallback(
    (menuType: SuggestionMenuType) =>
      ({ event }: { event: KeyboardEvent }) => {
        if (suggestionTypeRef.current !== menuType) return false;
        const len = suggestionItemsRef.current.length;
        if (event.key === 'ArrowDown') {
          setSuggestionIndex((i) => (i + 1) % Math.max(1, len));
          return true;
        }
        if (event.key === 'ArrowUp') {
          setSuggestionIndex((i) => (i - 1 + Math.max(1, len)) % Math.max(1, len));
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          // Run the command here, never inside a state updater: React may call
          // an updater twice (StrictMode, replayed renders), and a second run
          // re-applies the stale range and deletes the text after the chip.
          const item = suggestionItemsRef.current[suggestionIndexRef.current];
          if (item) {
            // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- source and target types do not overlap, so TS needs the unknown step
            suggestionCommandRef.current?.(item as unknown as Record<string, unknown>);
          }
          return true;
        }
        if (event.key === 'Escape') {
          setSuggestionType(null);
          return true;
        }
        return false;
      },
    [suggestionItemsRef, suggestionTypeRef, suggestionIndexRef],
  );

  // ── Handle suggestion item selection from the popup ──
  const handleSuggestionSelect = useCallback((item: SuggestionItem) => {
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- source and target types do not overlap, so TS needs the unknown step
    suggestionCommandRef.current?.(item as unknown as Record<string, unknown>);
  }, []);

  // Every member is stable (state setters, refs and memoized callbacks), so
  // the per-trigger configs can depend on this one object.
  const actions = useMemo(
    () => ({
      setSuggestionType,
      setSuggestionItems,
      setSuggestionIndex,
      setSuggestionLoading,
      setSuggestionTruncated,
      setSuggestionQuery,
      setSuggestionRect,
      suggestionCommandRef,
      suggestionTypeRef,
      suggestionQueryRef,
      triggerPosRef,
      editorRef,
      getFullQuery,
      applySuggestionItems,
      closeSuggestions,
      makeSuggestionKeyDown,
      handleSuggestionSelect,
    }),
    [
      suggestionTypeRef,
      suggestionQueryRef,
      getFullQuery,
      applySuggestionItems,
      closeSuggestions,
      makeSuggestionKeyDown,
      handleSuggestionSelect,
    ],
  );

  return {
    suggestionType,
    suggestionItems,
    suggestionIndex,
    suggestionLoading,
    suggestionTruncated,
    suggestionQuery,
    suggestionRect,
    actions,
  };
}

export type SuggestionMenu = ReturnType<typeof useSuggestionMenu>;
export type SuggestionMenuActions = SuggestionMenu['actions'];

/** Close the suggestion popup on a click outside the editor and the popup. */
export function useDismissSuggestionsOnOutsideClick(
  menu: SuggestionMenu,
  editor: PromptTiptapEditor,
) {
  const { suggestionType } = menu;
  const { setSuggestionType, setSuggestionItems, setSuggestionLoading, setSuggestionTruncated } =
    menu.actions;
  useEffect(() => {
    if (!suggestionType) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // Check if click is inside the editor
      try {
        if (editor?.view.dom.contains(target)) return;
      } catch {
        // editor view not mounted yet — fall through to other checks
      }
      // Check if click is inside the popup (portaled to body)
      const popup = document.querySelector('[data-suggestion-popup]');
      if (popup?.contains(target)) return;
      // Click is outside — dismiss the suggestion
      setSuggestionType(null);
      setSuggestionItems([]);
      setSuggestionLoading(false);
      setSuggestionTruncated(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [
    suggestionType,
    editor,
    setSuggestionType,
    setSuggestionItems,
    setSuggestionLoading,
    setSuggestionTruncated,
  ]);
}
