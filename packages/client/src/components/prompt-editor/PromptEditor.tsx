import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import History from '@tiptap/extension-history';
import Mention from '@tiptap/extension-mention';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Text from '@tiptap/extension-text';
import { EditorContent, useEditor } from '@tiptap/react';
import { forwardRef, useEffect, useLayoutEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

import {
  handlePromptDrop,
  handlePromptKeyDown,
  handlePromptPaste,
  scheduleCaretScroll,
} from './editor-handlers';
import { FileMention, SymbolMention } from './extensions';
import { SuggestionPopup } from './SuggestionPopup';
import type { PromptEditorHandle, PromptEditorProps } from './types';
import { usePromptEditorHandle } from './use-prompt-editor-handle';
import { usePromptEditorRefs } from './use-prompt-editor-refs';
import { useDismissSuggestionsOnOutsideClick, useSuggestionMenu } from './use-suggestion-menu';
import {
  useFileSuggestion,
  useSlashSuggestion,
  useSymbolSuggestion,
  useWorkflowSuggestion,
} from './use-trigger-suggestions';

export {
  buildSlashSuggestionItems,
  buildWorkflowSuggestionItems,
  getSuggestionLoadingLabel,
  WORKFLOW_SUGGESTION_MATCH_OPTIONS,
} from './suggestion-items';
export type { PromptEditorHandle, PromptSlashResource } from './types';

const PROMPT_EDITOR_INPUT_CLASS =
  'w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden min-h-[3.75rem] max-h-[35vh] overflow-y-auto scroll-fade-none';

// ── PromptEditor ─────────────────────────────────────────────────

export const PromptEditor = forwardRef<PromptEditorHandle, PromptEditorProps>(
  function PromptEditor(props, ref) {
    const { placeholder, disabled, onPaste, className, containerRef } = props;
    const refs = usePromptEditorRefs(props);
    const menu = useSuggestionMenu();
    const { actions, suggestionType } = menu;

    const fileSuggestion = useFileSuggestion(actions, refs.cwdRef);
    const slashSuggestion = useSlashSuggestion(actions, suggestionType, props, refs);
    const workflowSuggestion = useWorkflowSuggestion(actions, suggestionType, props, refs);
    const symbolSuggestion = useSymbolSuggestion(actions, refs.cwdRef);

    // A burst of input can produce many editor transactions in the same frame.
    // Keep at most one geometry check pending so typing does not repeatedly force
    // layout before the browser can paint the editor update.
    const caretScrollFrameRef = useRef<number | null>(null);

    // ── TipTap editor ──
    const editor = useEditor({
      immediatelyRender: true,
      autofocus: 'end',
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak,
        History,
        // Keep the hint visible while disabled (e.g. the prompt dock shown
        // during thread preparation), not just while editable.
        Placeholder.configure({ placeholder: placeholder ?? '', showOnlyWhenEditable: false }),
        // File mentions (@ trigger)
        FileMention.configure({
          HTMLAttributes: { class: 'file-mention' },
          suggestion: fileSuggestion(),
          deleteTriggerWithBackspace: true,
        }),
        // Slash commands (/ trigger)
        Mention.extend({
          name: 'slashCommand',
          renderHTML({ node, HTMLAttributes }) {
            return [
              'span',
              {
                ...HTMLAttributes,
                class: 'slash-command',
              },
              node.attrs.label || node.attrs.id,
            ];
          },
        }).configure({
          HTMLAttributes: { class: 'slash-command' },
          suggestion: slashSuggestion(),
          deleteTriggerWithBackspace: true,
        }),
        // Workflow invocations (>> trigger)
        Mention.extend({
          name: 'workflowInvocation',
        }).configure({
          suggestion: workflowSuggestion(),
          deleteTriggerWithBackspace: true,
        }),
        // Symbol mentions (# trigger)
        SymbolMention.configure({
          HTMLAttributes: { class: 'symbol-mention' },
          suggestion: symbolSuggestion(),
          deleteTriggerWithBackspace: true,
        }),
      ],
      editorProps: {
        attributes: {
          'data-testid': 'prompt-editor',
          'aria-label': 'Message',
          class: PROMPT_EDITOR_INPUT_CLASS,
          role: 'textbox',
        },
        handleKeyDown: (view, event) =>
          handlePromptKeyDown(
            {
              suggestionTypeRef: actions.suggestionTypeRef,
              onCycleModeRef: refs.onCycleModeRef,
              onHistoryNavigateRef: refs.onHistoryNavigateRef,
              onSubmitRef: refs.onSubmitRef,
            },
            view,
            event,
          ),
        handlePaste: (_view, event) => handlePromptPaste(onPaste, event),
        handleDrop: (view, event) => handlePromptDrop(refs.onFileMentionDropRef, view, event),
      },
      onUpdate: ({ editor: ed }) => {
        refs.onChangeRef.current?.();
        scheduleCaretScroll(ed, caretScrollFrameRef);
      },
      editable: !disabled,
    });
    const { editorRef } = actions;
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
          ext.options.placeholder = placeholder ?? '';
          editor.view.dispatch(editor.state.tr);
        }
      });
    }, [editor, placeholder]);

    // Update editable state
    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      editor.setEditable(!disabled);
    }, [editor, disabled]);

    usePromptEditorHandle(ref, editor);

    // ── Close suggestion popup on click outside ──
    useDismissSuggestionsOnOutsideClick(menu, editor);

    return (
      <>
        <EditorContent editor={editor} className={cn('tiptap-prompt-editor', className)} />
        {suggestionType && (
          <SuggestionPopup
            items={menu.suggestionItems}
            selectedIndex={menu.suggestionIndex}
            loading={menu.suggestionLoading}
            truncated={
              suggestionType === 'file' || suggestionType === 'symbol'
                ? menu.suggestionTruncated
                : false
            }
            onSelect={actions.handleSuggestionSelect}
            onHover={actions.setSuggestionIndex}
            rect={menu.suggestionRect}
            type={suggestionType}
            query={menu.suggestionQuery}
            containerRef={containerRef}
          />
        )}
      </>
    );
  },
);
