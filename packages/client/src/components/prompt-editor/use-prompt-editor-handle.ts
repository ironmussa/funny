import { TextSelection } from '@tiptap/pm/state';
import type { Editor, JSONContent } from '@tiptap/react';
import { useImperativeHandle, useRef } from 'react';

import { insertInlineNodeWithTrailingSpace, isString } from './extensions';
import type { PromptEditorHandle } from './types';

type DictationRange = { from: number; to: number } | null;

/** Clamp a tracked dictation range to valid document positions. */
function clampDictationRange(range: DictationRange, docSize: number) {
  const safeFrom = range ? Math.min(Math.max(range.from, 0), docSize) : null;
  const safeTo = range ? Math.min(Math.max(range.to, 0), docSize) : null;
  return { safeFrom, safeTo };
}

/** Shows `text` as the dictation partial; returns where the partial starts. */
function applyDictationPreview(editor: Editor, range: DictationRange, text: string): number {
  const { state } = editor;

  // Clamp range to valid document positions
  const { safeFrom, safeTo } = clampDictationRange(range, state.doc.content.size);

  if (safeFrom !== null && safeTo !== null && safeFrom < safeTo) {
    // Validate that the range still contains text (not nodes that shifted)
    const slice = state.doc.textBetween(safeFrom, safeTo, '');
    if (slice.length > 0) {
      // Replace previous partial with new partial using a single transaction
      const tr = state.tr.replaceWith(safeFrom, safeTo, state.schema.text(text));
      // Place cursor at end of replaced text
      const endPos = safeFrom + text.length;
      tr.setSelection(TextSelection.create(tr.doc, endPos));
      editor.view.dispatch(tr);
      return safeFrom;
    }
    // Range is invalid/empty — just insert at cursor
    const from = state.selection.from;
    const tr = state.tr.insertText(text, from);
    editor.view.dispatch(tr);
    return from;
  }
  // First partial — insert at current cursor
  const from = state.selection.from;
  const tr = state.tr.insertText(text, from);
  editor.view.dispatch(tr);
  return from;
}

/** Replaces the dictation partial with the final text (plus a space). */
function applyDictationCommit(editor: Editor, range: DictationRange, text: string) {
  const { state } = editor;
  const finalText = text + ' ';

  const { safeFrom, safeTo } = clampDictationRange(range, state.doc.content.size);

  if (safeFrom !== null && safeTo !== null && safeFrom < safeTo) {
    const tr = state.tr.replaceWith(safeFrom, safeTo, state.schema.text(finalText));
    // Place cursor at end of committed text so next dictation inserts here
    const endPos = safeFrom + finalText.length;
    tr.setSelection(TextSelection.create(tr.doc, endPos));
    editor.view.dispatch(tr);
  } else {
    // No valid partial range — insert at cursor
    const from = state.selection.from;
    const tr = state.tr.insertText(finalText, from);
    editor.view.dispatch(tr);
  }
}

// ── Imperative handle ──
// Tiptap destroys the underlying editor on unmount (Strict Mode reconnect,
// HMR, fast remounts). The React closure can still hold the reference and
// calls into `editor.commands` / `editor.extensionManager` after destroy
// throw a null deref. Guard every entry point with `isDestroyed`.
export function usePromptEditorHandle(
  ref: React.ForwardedRef<PromptEditorHandle>,
  editor: Editor | null,
) {
  // Dictation partial tracking: [startPos, endPos] in the document
  const dictationRangeRef = useRef<DictationRange>(null);

  const alive = (ed: typeof editor): ed is NonNullable<typeof editor> => !!ed && !ed.isDestroyed;
  useImperativeHandle(
    ref,
    () => ({
      getJSON: () => (alive(editor) ? editor.getJSON() : undefined),
      setContent: (content: JSONContent | string) => {
        if (!alive(editor)) return;
        // emitUpdate=false: prevents onUpdate from firing for programmatic
        // restores, which would otherwise call the parent's onChange with
        // potentially stale closure state and clobber persisted text.
        if (isString(content)) {
          editor.commands.setContent(content ? `<p>${content}</p>` : '', { emitUpdate: false });
        } else {
          editor.commands.setContent(content, { emitUpdate: false });
        }
      },
      getText: () => (alive(editor) ? editor.getText() : ''),
      focus: () => {
        if (alive(editor)) editor.commands.focus();
      },
      clear: () => {
        if (alive(editor)) editor.commands.clearContent();
      },
      isEmpty: () => (alive(editor) ? editor.isEmpty : true),
      insertFileMention: (path: string, fileType: 'file' | 'folder') => {
        if (!alive(editor)) return;
        const label = path.split('/').pop() ?? path;
        insertInlineNodeWithTrailingSpace(
          editor,
          { from: editor.state.selection.from, to: editor.state.selection.to },
          'fileMention',
          { id: path, label, path, fileType },
        );
      },
      insertText: (text: string) => {
        if (!alive(editor)) return;
        editor.chain().focus().insertContent(text).run();
      },
      setDictationPreview: (text: string) => {
        if (!alive(editor)) return;
        const insertFrom = applyDictationPreview(editor, dictationRangeRef.current, text);
        dictationRangeRef.current = { from: insertFrom, to: insertFrom + text.length };
      },
      commitDictation: (text: string) => {
        if (!alive(editor)) return;
        applyDictationCommit(editor, dictationRangeRef.current, text);
        dictationRangeRef.current = null;
      },
      endDictation: () => {
        dictationRangeRef.current = null;
      },
    }),
    [editor],
  );
}
