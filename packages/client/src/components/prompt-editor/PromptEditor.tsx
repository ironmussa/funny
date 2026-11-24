import { EditorContent } from '@tiptap/react';
import { forwardRef, useEffect } from 'react';

import { cn } from '@/lib/utils';

import type { PromptSlashResource, PromptWorkflowResource } from './suggestion-items';
import { SuggestionPopup } from './SuggestionPopup';
import { type PromptEditorHandle, usePromptEditorHandle } from './use-prompt-editor-handle';
import { usePromptEditorInstance } from './use-prompt-editor-instance';
import { usePromptEditorSuggestions } from './use-prompt-editor-suggestions';
import type { SuggestionControls } from './use-suggestion-menu';

export type { PromptEditorHandle } from './use-prompt-editor-handle';
export type { PromptSlashResource } from './suggestion-items';
export {
  buildSlashSuggestionItems,
  buildWorkflowSuggestionItems,
  getSuggestionLoadingLabel,
  WORKFLOW_SUGGESTION_MATCH_OPTIONS,
} from './suggestion-items';

interface PromptEditorProps {
  placeholder?: string;
  disabled?: boolean;
  /** Called on Enter (without Shift) */
  onSubmit?: () => void;
  /** Called on Shift+Tab to cycle permission mode */
  onCycleMode?: () => void;
  /** Navigate submitted user messages when the caret reaches the editor boundary. */
  onHistoryNavigate?: (direction: 'previous' | 'next') => boolean;
  /** Called when content changes */
  onChange?: () => void;
  /** Called when image is pasted */
  onPaste?: (e: ClipboardEvent) => void;
  /** Called after the editor consumes a file-mention drop (so outer wrappers can reset drag state) */
  onFileMentionDrop?: () => void;
  /** Effective cwd for file browsing */
  cwd?: string;
  /** Resolved provider-scoped skills + custom slash commands for the `/` menu.
   *  The editor does NOT cache these — it renders whatever is passed, so the
   *  owner (via `useSlashSkills`) is the single source of truth. */
  slashSkills?: readonly PromptSlashResource[];
  /** True while {@link slashSkills} is being (re)loaded. Drives the `/` menu's
   *  loading state when no skills are available yet. */
  slashSkillsLoading?: boolean;
  /** Called when the `/` menu opens. Lazy owners use this to trigger their
   *  first fetch; eager owners can omit it. Safe to call repeatedly. */
  onSlashOpen?: () => void;
  /** SDK-reported slash commands for the active thread (names without leading
   *  slash), merged into the / autocomplete alongside skills. */
  sdkSlashCommands?: string[];
  /** Workflows available in the active project, shown by the `>>` menu. */
  workflows?: readonly PromptWorkflowResource[];
  /** True while workflows are being loaded for the `>>` menu. */
  workflowsLoading?: boolean;
  /** Effective provider for the slash menu. Claude-specific built-in command
   *  descriptions are only applied when this is `'claude'` — other providers
   *  (e.g. Codex, which has its own /init, /compact, /review) must not be
   *  labelled with Claude's wording. */
  commandProvider?: string;
  className?: string;
  /** Ref to the outer container — suggestion popup will match its width */
  containerRef?: React.RefObject<HTMLElement | null>;
}

/** Closes the open suggestion menu when the user clicks outside it and the editor. */
function useDismissSuggestionsOnOutsideClick(
  suggestionType: string | null,
  editor: ReturnType<typeof usePromptEditorInstance>,
  controls: SuggestionControls,
) {
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
      controls.setSuggestionType(null);
      controls.setSuggestionItems([]);
      controls.setSuggestionLoading(false);
      controls.setSuggestionTruncated(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [suggestionType, editor, controls]);
}

// ── PromptEditor ─────────────────────────────────────────────────

export const PromptEditor = forwardRef<PromptEditorHandle, PromptEditorProps>(function PromptEditor(
  {
    placeholder,
    disabled,
    onSubmit,
    onCycleMode,
    onHistoryNavigate,
    onChange,
    onPaste,
    onFileMentionDrop,
    cwd,
    slashSkills,
    slashSkillsLoading,
    onSlashOpen,
    sdkSlashCommands,
    workflows,
    workflowsLoading,
    commandProvider,
    className,
    containerRef,
  },
  ref,
) {
  const { state, controls, suggestionTypeRef, editorRef, configs, handleSuggestionSelect } =
    usePromptEditorSuggestions({
      cwd,
      slashSkills,
      slashSkillsLoading,
      onSlashOpen,
      sdkSlashCommands,
      workflows,
      workflowsLoading,
      commandProvider,
    });
  const { suggestionType } = state;

  const editor = usePromptEditorInstance({
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
  });

  usePromptEditorHandle(ref, editor);
  useDismissSuggestionsOnOutsideClick(suggestionType, editor, controls);

  return (
    <>
      <EditorContent editor={editor} className={cn('tiptap-prompt-editor', className)} />
      {suggestionType && (
        <SuggestionPopup
          items={state.suggestionItems}
          selectedIndex={state.suggestionIndex}
          loading={state.suggestionLoading}
          truncated={
            suggestionType === 'file' || suggestionType === 'symbol'
              ? state.suggestionTruncated
              : false
          }
          onSelect={handleSuggestionSelect}
          onHover={controls.setSuggestionIndex}
          rect={state.suggestionRect}
          type={suggestionType}
          query={state.suggestionQuery}
          containerRef={containerRef}
        />
      )}
    </>
  );
});
