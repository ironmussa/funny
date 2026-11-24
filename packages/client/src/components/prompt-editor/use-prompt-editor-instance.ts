import type { MentionOptions } from '@tiptap/extension-mention';
import { type Editor, useEditor } from '@tiptap/react';
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

import {
  handleFileMentionDrop,
  handleImagePaste,
  handlePromptKeyDown,
  scrollCaretIntoView,
} from './editor-handlers';
import { buildPromptEditorExtensions } from './extensions';
import type { SuggestionMenuType } from './suggestion-items';

const PROMPT_EDITOR_INPUT_CLASS =
  'w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden min-h-[3.75rem] max-h-[35vh] overflow-y-auto scroll-fade-none';

type SuggestionConfigFactory = () => MentionOptions['suggestion'];

interface PromptEditorInstanceOptions {
  placeholder?: string;
  disabled?: boolean;
  onSubmit?: () => void;
  onCycleMode?: () => void;
  onHistoryNavigate?: (direction: 'previous' | 'next') => boolean;
  onChange?: () => void;
  onPaste?: (e: ClipboardEvent) => void;
  onFileMentionDrop?: () => void;
  suggestionTypeRef: RefObject<SuggestionMenuType | null>;
  editorRef: RefObject<Editor | null>;
  configs: {
    fileSuggestion: SuggestionConfigFactory;
    slashSuggestion: SuggestionConfigFactory;
    workflowSuggestion: SuggestionConfigFactory;
    symbolSuggestion: SuggestionConfigFactory;
  };
}

/** The TipTap editor behind the prompt, kept in sync with the owner's props. */
export function usePromptEditorInstance({
  placeholder,
  disabled,
  onSubmit,
  onCycleMode,
  onHistoryNavigate,
  onChange,
  onPaste,
  onFileMentionDrop,
  suggestionTypeRef,
  editorRef,
  configs,
}: PromptEditorInstanceOptions) {
  // A burst of input can produce many editor transactions in the same frame.
  // Keep at most one geometry check pending so typing does not repeatedly force
  // layout before the browser can paint the editor update.
  const caretScrollFrameRef = useRef<number | null>(null);

  const onSubmitRef = useRef(onSubmit);
  const onCycleModeRef = useRef(onCycleMode);
  const onHistoryNavigateRef = useRef(onHistoryNavigate);
  const onChangeRef = useRef(onChange);
  const onFileMentionDropRef = useRef(onFileMentionDrop);

  useLayoutEffect(() => {
    onSubmitRef.current = onSubmit;
    onCycleModeRef.current = onCycleMode;
    onHistoryNavigateRef.current = onHistoryNavigate;
    onChangeRef.current = onChange;
    onFileMentionDropRef.current = onFileMentionDrop;
  }, [onChange, onCycleMode, onFileMentionDrop, onHistoryNavigate, onSubmit]);

  const editor = useEditor({
    immediatelyRender: true,
    autofocus: 'end',
    extensions: buildPromptEditorExtensions(placeholder, {
      file: configs.fileSuggestion(),
      slash: configs.slashSuggestion(),
      workflow: configs.workflowSuggestion(),
      symbol: configs.symbolSuggestion(),
    }),
    editorProps: {
      attributes: {
        'data-testid': 'prompt-editor',
        'aria-label': 'Message',
        class: PROMPT_EDITOR_INPUT_CLASS,
        role: 'textbox',
      },
      handleKeyDown: (view, event) =>
        handlePromptKeyDown(view, event, {
          suggestionTypeRef,
          onSubmitRef,
          onCycleModeRef,
          onHistoryNavigateRef,
        }),
      handlePaste: (_view, event) => handleImagePaste(event, onPaste),
      handleDrop: (view, event) => handleFileMentionDrop(view, event, onFileMentionDropRef.current),
    },
    onUpdate: ({ editor: ed }) => {
      onChangeRef.current?.();
      // Keep the caret in view — PM's scrollIntoView can lag behind our height
      // animation, so we re-assert it on the next frame. Coalesce bursts of
      // keystrokes and skip the geometry reads entirely while the editor has
      // no internal overflow; a one-line prompt cannot need scrolling.
      if (caretScrollFrameRef.current !== null) return;
      caretScrollFrameRef.current = requestAnimationFrame(() => {
        caretScrollFrameRef.current = null;
        scrollCaretIntoView(ed);
      });
    },
    editable: !disabled,
  });
  useLayoutEffect(() => {
    editorRef.current = editor;
  }, [editor, editorRef]);

  useEffect(
    () => () => {
      if (caretScrollFrameRef.current !== null) {
        cancelAnimationFrame(caretScrollFrameRef.current);
      }
    },
    [],
  );

  // Update placeholder when it changes
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.extensionManager.extensions.forEach((ext) => {
      if (ext.name === 'placeholder') {
        (ext.options as any).placeholder = placeholder ?? '';
        editor.view.dispatch(editor.state.tr);
      }
    });
  }, [editor, placeholder]);

  // Update editable state
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  return editor;
}
