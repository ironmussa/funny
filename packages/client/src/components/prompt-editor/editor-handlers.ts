import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { Editor } from '@tiptap/react';

import { readFileMentionDragData } from '@/lib/file-mention-dnd';

import type { SuggestionMenuType } from './types';

type RefOf<T> = React.RefObject<T>;

interface KeyDownRefs {
  suggestionTypeRef: RefOf<SuggestionMenuType | null>;
  onCycleModeRef: RefOf<(() => void) | undefined>;
  onHistoryNavigateRef: RefOf<((direction: 'previous' | 'next') => boolean) | undefined>;
  onSubmitRef: RefOf<(() => void) | undefined>;
}

/**
 * Preserve normal multiline cursor movement. History navigation is
 * only active when the caret is at the start/end of the document.
 */
function historyDirectionFor(
  refs: KeyDownRefs,
  view: EditorView,
  event: KeyboardEvent,
): 'previous' | 'next' | null {
  if (refs.suggestionTypeRef.current || !view.state.selection.empty) return null;
  const { from } = view.state.selection;
  if (event.key === 'ArrowUp' && from <= 1) return 'previous';
  // A text selection at the end of a paragraph is one position before
  // the document content boundary (the paragraph's closing token).
  if (event.key === 'ArrowDown' && from >= view.state.doc.content.size - 1) return 'next';
  return null;
}

/** Editor-level keys: Shift+Tab cycles the mode, history at the edges, Enter submits. */
export function handlePromptKeyDown(refs: KeyDownRefs, _view: EditorView, event: KeyboardEvent) {
  // Shift+Tab: cycle permission mode
  if (event.key === 'Tab' && event.shiftKey) {
    event.preventDefault();
    refs.onCycleModeRef.current?.();
    return true;
  }
  const historyDirection = historyDirectionFor(refs, _view, event);
  if (historyDirection) {
    return refs.onHistoryNavigateRef.current?.(historyDirection) ?? false;
  }
  // Enter without shift → submit
  if (event.key === 'Enter' && !event.shiftKey) {
    // If a suggestion popup is open, let the suggestion handle it
    if (refs.suggestionTypeRef.current) return false;
    event.preventDefault();
    refs.onSubmitRef.current?.();
    return true;
  }
  return false;
}

/** Hands a pasted image to the owner; any other paste is left to the editor. */
export function handlePromptPaste(
  onPaste: ((e: ClipboardEvent) => void) | undefined,
  event: ClipboardEvent,
) {
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

/** Inserts a dropped file mention chip at the drop point. */
export function handlePromptDrop(
  onFileMentionDropRef: RefOf<(() => void) | undefined>,
  view: EditorView,
  event: DragEvent,
) {
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
  onFileMentionDropRef.current?.();
  return true;
}

/**
 * Keep the caret in view — PM's scrollIntoView can lag behind our height
 * animation, so we re-assert it on the next frame. Coalesce bursts of
 * keystrokes and skip the geometry reads entirely while the editor has
 * no internal overflow; a one-line prompt cannot need scrolling.
 */
export function scheduleCaretScroll(ed: Editor, caretScrollFrameRef: RefOf<number | null>) {
  if (caretScrollFrameRef.current !== null) return;
  caretScrollFrameRef.current = requestAnimationFrame(() => {
    caretScrollFrameRef.current = null;
    try {
      const dom = ed.view.dom;
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
  });
}
