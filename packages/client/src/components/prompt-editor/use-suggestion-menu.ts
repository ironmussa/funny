import type { Editor } from '@tiptap/react';
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';

import type { SuggestionItem, SuggestionMenuType } from './suggestion-items';

type SuggestionRect = (() => DOMRect | null) | null;
/** TipTap's `command` of the open menu: inserts the chosen item. */
type SuggestionCommand = (item: SuggestionItem) => void;

/**
 * Read the full text after a trigger character (@, /, #, or >) up to the next
 * whitespace or end of the text node, regardless of caret position.
 * Falls back to TipTap's query if the editor isn't available.
 */
function readFullQuery(ed: Editor | null, triggerFrom: number | null, tiptapQuery: string): string {
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
}

interface MenuKeyContext {
  itemsRef: RefObject<SuggestionItem[]>;
  indexRef: RefObject<number>;
  commandRef: RefObject<SuggestionCommand | null>;
  setSuggestionIndex: Dispatch<SetStateAction<number>>;
  setSuggestionType: Dispatch<SetStateAction<SuggestionMenuType | null>>;
}

/** Keys of the open menu: move the selection, pick the item, or close. */
function handleMenuKey(event: KeyboardEvent, ctx: MenuKeyContext): boolean {
  const len = ctx.itemsRef.current.length;
  if (event.key === 'ArrowDown') {
    ctx.setSuggestionIndex((i) => (i + 1) % Math.max(1, len));
    return true;
  }
  if (event.key === 'ArrowUp') {
    ctx.setSuggestionIndex((i) => (i - 1 + Math.max(1, len)) % Math.max(1, len));
    return true;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    // Run the command here, never inside a state updater: React may call
    // an updater twice (StrictMode, replayed renders), and a second run
    // re-applies the stale range and deletes the text after the chip.
    const item = ctx.itemsRef.current[ctx.indexRef.current];
    if (item) ctx.commandRef.current?.(item);
    return true;
  }
  if (event.key === 'Escape') {
    ctx.setSuggestionType(null);
    return true;
  }
  return false;
}

/**
 * Refs for suggestion state accessed inside closures captured at editor
 * creation time, kept current in a layout effect.
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
  useLayoutEffect(() => {
    suggestionItemsRef.current = items;
    suggestionTypeRef.current = type;
    suggestionQueryRef.current = query;
    suggestionIndexRef.current = index;
  }, [items, type, query, index]);
  return { suggestionItemsRef, suggestionTypeRef, suggestionQueryRef, suggestionIndexRef };
}

/** Whether the menu's item list is a different one (by ids), not just refreshed. */
function itemIdsChanged(previousItems: SuggestionItem[], items: SuggestionItem[]): boolean {
  return (
    previousItems.length !== items.length ||
    previousItems.some((item, index) => item.id !== items[index]?.id)
  );
}

/** The suggestion state (shared for every trigger) and its setters. */
function useSuggestionMenuState() {
  const [suggestionType, setSuggestionType] = useState<SuggestionMenuType | null>(null);
  const [suggestionItems, setSuggestionItems] = useState<SuggestionItem[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionTruncated, setSuggestionTruncated] = useState(false);
  const [suggestionQuery, setSuggestionQuery] = useState('');
  const [suggestionRect, setSuggestionRect] = useState<SuggestionRect>(null);
  // The setters are stable, so this object is created once.
  const setters = useMemo(
    () => ({
      setSuggestionType,
      setSuggestionItems,
      setSuggestionIndex,
      setSuggestionLoading,
      setSuggestionTruncated,
      setSuggestionQuery,
      setSuggestionRect,
    }),
    [],
  );
  return {
    state: {
      suggestionType,
      suggestionItems,
      suggestionIndex,
      suggestionLoading,
      suggestionTruncated,
      suggestionQuery,
      suggestionRect,
    },
    setters,
  };
}

/**
 * The single suggestion menu shared by every trigger (@, /, #, >>): its state,
 * the refs the TipTap callbacks read it through, and the operations on it.
 */
export function useSuggestionMenu() {
  const { state, setters } = useSuggestionMenuState();
  const { suggestionType, suggestionItems, suggestionIndex, suggestionQuery } = state;
  const {
    setSuggestionType,
    setSuggestionItems,
    setSuggestionIndex,
    setSuggestionLoading,
    setSuggestionTruncated,
    setSuggestionQuery,
  } = setters;
  const suggestionCommandRef = useRef<SuggestionCommand | null>(null);

  const stateRefs = useSuggestionStateRefs(
    suggestionItems,
    suggestionType,
    suggestionQuery,
    suggestionIndex,
  );
  const { suggestionItemsRef, suggestionTypeRef, suggestionIndexRef } = stateRefs;

  // Track the trigger position so we can read the full query (@ to next space/EOL)
  // regardless of caret position
  const triggerPosRef = useRef<number | null>(null);
  const editorRef = useRef<Editor | null>(null);

  /** The full query after the open trigger (see `readFullQuery`). */
  const getFullQuery = useCallback(
    (tiptapQuery: string): string =>
      readFullQuery(editorRef.current, triggerPosRef.current, tiptapQuery),
    [],
  );

  const applySuggestionItems = useCallback(
    (items: SuggestionItem[]) => {
      const changed = itemIdsChanged(suggestionItemsRef.current, items);
      suggestionItemsRef.current = items;
      setSuggestionItems(items);
      if (changed) setSuggestionIndex(0);
    },
    [suggestionItemsRef, setSuggestionItems, setSuggestionIndex],
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
  }, [
    setSuggestionType,
    setSuggestionItems,
    setSuggestionQuery,
    setSuggestionLoading,
    setSuggestionTruncated,
  ]);

  const makeSuggestionKeyDown = useCallback(
    (menuType: SuggestionMenuType) =>
      ({ event }: { event: KeyboardEvent }) => {
        if (suggestionTypeRef.current !== menuType) return false;
        return handleMenuKey(event, {
          itemsRef: suggestionItemsRef,
          indexRef: suggestionIndexRef,
          commandRef: suggestionCommandRef,
          setSuggestionIndex,
          setSuggestionType,
        });
      },
    [
      suggestionItemsRef,
      suggestionTypeRef,
      suggestionIndexRef,
      setSuggestionIndex,
      setSuggestionType,
    ],
  );

  // Every member is stable except the callbacks, so this changes only when
  // they do.
  const controls = useMemo(
    () => ({
      ...setters,
      suggestionCommandRef,
      triggerPosRef,
      getFullQuery,
      applySuggestionItems,
      closeSuggestions,
      makeSuggestionKeyDown,
    }),
    [setters, applySuggestionItems, closeSuggestions, getFullQuery, makeSuggestionKeyDown],
  );

  return {
    state,
    controls,
    stateRefs,
    editorRef,
  };
}

export type SuggestionControls = ReturnType<typeof useSuggestionMenu>['controls'];
