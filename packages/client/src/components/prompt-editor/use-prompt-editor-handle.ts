import { TextSelection } from '@tiptap/pm/state';
import type { Editor, JSONContent } from '@tiptap/react';
import { useImperativeHandle, useRef, type Ref } from 'react';

import { insertInlineNodeWithTrailingSpace } from './extensions';

export interface PromptEditorHandle {
  /** Get the TipTap JSONContent for draft persistence */
  getJSON(): JSONContent | undefined;
  /** Set the editor content from JSON (draft restore) */
  setContent(content: JSONContent | string): void;
  /** Get plain text */
  getText(): string;
  /** Focus the editor */
  focus(): void;
  /** Clear the editor */
  clear(): void;
  /** Check if the editor is empty */
  isEmpty(): boolean;
  /** Insert a file mention node at the current cursor position */
  insertFileMention(path: string, fileType: 'file' | 'folder'): void;
  /** Insert plain text at the current cursor position */
  insertText(text: string): void;
  /** Show partial dictation text (replaces previous partial) */
  setDictationPreview(text: string): void;
  /** Commit the dictation partial as real text and reset tracking */
  commitDictation(text: string): void;
  /** Reset dictation tracking without changing text — call when the mic stops mid-turn */
  endDictation(): void;
}

type DictationRange = { from: number; to: number } | null;

/** Clamps the tracked dictation range to valid document positions. */
function clampDictationRange(editor: Editor, range: DictationRange) {
  const docSize = editor.state.doc.content.size;
  const safeFrom = range ? Math.min(Math.max(range.from, 0), docSize) : null;
  const safeTo = range ? Math.min(Math.max(range.to, 0), docSize) : null;
  return { safeFrom, safeTo };
}

/** Replaces the previous dictation partial with `text`; returns where it starts. */
function showDictationPreview(editor: Editor, range: DictationRange, text: string): number {
  const { state } = editor;
  const { safeFrom, safeTo } = clampDictationRange(editor, range);

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
  }
  // First partial (or a stale range) — insert at current cursor
  const from = state.selection.from;
  const tr = state.tr.insertText(text, from);
  editor.view.dispatch(tr);
  return from;
}

/** Commits the dictation partial as `text` followed by a space. */
function commitDictationText(editor: Editor, range: DictationRange, text: string) {
  const { state } = editor;
  const finalText = text + ' ';
  const { safeFrom, safeTo } = clampDictationRange(editor, range);

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

export function usePromptEditorHandle(ref: Ref<PromptEditorHandle>, editor: Editor | null) {
  // Dictation partial tracking: [startPos, endPos] in the document
  const dictationRangeRef = useRef<DictationRange>(null);

  // ── Imperative handle ──
  // Tiptap destroys the underlying editor on unmount (Strict Mode reconnect,
  // HMR, fast remounts). The React closure can still hold the reference and
  // calls into `editor.commands` / `editor.extensionManager` after destroy
  // throw a null deref. Guard every entry point with `isDestroyed`.
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
        if (typeof content === 'string') {
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
        const insertFrom = showDictationPreview(editor, dictationRangeRef.current, text);
        dictationRangeRef.current = { from: insertFrom, to: insertFrom + text.length };
      },
      commitDictation: (text: string) => {
        if (!alive(editor)) return;
        commitDictationText(editor, dictationRangeRef.current, text);
        dictationRangeRef.current = null;
      },
      endDictation: () => {
        dictationRangeRef.current = null;
      },
    }),
    [editor],
  );
}
