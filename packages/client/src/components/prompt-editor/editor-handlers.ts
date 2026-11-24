import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Editor } from '@tiptap/react';
import type { RefObject } from 'react';

import { readFileMentionDragData } from '@/lib/file-mention-dnd';

import type { SuggestionMenuType } from './suggestion-items';

export interface PromptKeyRefs {
  suggestionTypeRef: RefObject<SuggestionMenuType | null>;
  onSubmitRef: RefObject<(() => void) | undefined>;
  onCycleModeRef: RefObject<(() => void) | undefined>;
  onHistoryNavigateRef: RefObject<((direction: 'previous' | 'next') => boolean) | undefined>;
}

/** The history step a caret key asks for, if the caret is at that document edge. */
function historyDirection(view: EditorView, key: string): 'previous' | 'next' | null {
  const { from } = view.state.selection;
  if (key === 'ArrowUp' && from <= 1) return 'previous';
  // A text selection at the end of a paragraph is one position before
  // the document content boundary (the paragraph's closing token).
  if (key === 'ArrowDown' && from >= view.state.doc.content.size - 1) return 'next';
  return null;
}

/**
 * Preserve normal multiline cursor movement. History navigation is only
 * active when the caret is at the start/end of the document.
 */
function handleHistoryKey(view: EditorView, event: KeyboardEvent, refs: PromptKeyRefs): boolean {
  if (refs.suggestionTypeRef.current || !view.state.selection.empty) return false;
  const direction = historyDirection(view, event.key);
  if (!direction) return false;
  return refs.onHistoryNavigateRef.current?.(direction) ?? false;
}

/** Enter without shift → submit, unless a suggestion popup is open to take it. */
function submitOnEnter(event: KeyboardEvent, refs: PromptKeyRefs): boolean {
  if (refs.suggestionTypeRef.current) return false;
  event.preventDefault();
  refs.onSubmitRef.current?.();
  return true;
}

export function handlePromptKeyDown(
  view: EditorView,
  event: KeyboardEvent,
  refs: PromptKeyRefs,
): boolean {
  // Shift+Tab: cycle permission mode
  if (event.key === 'Tab' && event.shiftKey) {
    event.preventDefault();
    refs.onCycleModeRef.current?.();
    return true;
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    return handleHistoryKey(view, event, refs);
  }
  if (event.key === 'Enter' && !event.shiftKey) return submitOnEnter(event, refs);
  return false;
}

export function handleImagePaste(
  event: ClipboardEvent,
  onPaste: ((e: ClipboardEvent) => void) | undefined,
): boolean {
  // Check for images in the clipboard
  const items = event.clipboardData?.items;
  if (!items) return false;
  for (const item of Array.from(items)) {
    if (item.type.startsWith('image/')) {
      event.preventDefault();
      onPaste?.(event);
      return true;
    }
  }
  return false;
}

export function handleFileMentionDrop(
  view: EditorView,
  event: DragEvent,
  onDropped: (() => void) | undefined,
): boolean {
  const dt = event.dataTransfer;
  if (!dt) return false;
  const mention = readFileMentionDragData(dt);
  if (!mention) return false;
  event.preventDefault();
  event.stopPropagation();
  const { schema } = view.state;
  const mentionType = schema.nodes.fileMention;
  if (!mentionType) return false;
  const label = mention.path.split('/').pop() ?? mention.path;
  const node = mentionType.create({
    id: mention.path,
    label,
    path: mention.path,
    fileType: mention.fileType,
  });
  const space = schema.text(' ');
  const dropPos = view.posAtCoords({
    left: event.clientX,
    top: event.clientY,
  });
  const insertAt = dropPos ? dropPos.pos : view.state.selection.from;
  const tr = view.state.tr.insert(insertAt, [node, space]);
  const after = insertAt + node.nodeSize + space.nodeSize;
  tr.setSelection(TextSelection.create(tr.doc, after));
  view.dispatch(tr);
  view.focus();
  onDropped?.();
  return true;
}

/** Scrolls the editor so the caret is visible, when the editor overflows. */
export function scrollCaretIntoView(ed: Editor) {
  try {
    const dom = ed.view.dom as HTMLElement;
    if (dom.scrollHeight <= dom.clientHeight) return;
    const coords = ed.view.coordsAtPos(ed.state.selection.from);
    const rect = dom.getBoundingClientRect();
    const offsetBottom = coords.bottom - rect.top;
    const offsetTop = coords.top - rect.top;
    if (offsetBottom > dom.clientHeight) {
      dom.scrollTop += offsetBottom - dom.clientHeight + 4;
    } else if (offsetTop < 0) {
      dom.scrollTop += offsetTop - 4;
    }
  } catch {
    /* selection may be invalid mid-update */
  }
}
