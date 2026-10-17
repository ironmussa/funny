import { useCallback, useRef, useState } from 'react';

import type { PromptEditorHandle } from '@/components/prompt-editor/PromptEditor';
import { useIsMobile } from '@/hooks/use-mobile';

/** Elements that keep their own focus when the prompt box is clicked. */
const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, [role="switch"], [role="combobox"], [role="listbox"], [role="option"], [data-vaul-drawer], [data-vaul-overlay], [data-radix-popper-content-wrapper]';

interface UsePromptEditorBindingsParams {
  editorRef?: React.RefObject<PromptEditorHandle | null>;
  editorContainerRef?: React.RefObject<HTMLDivElement | null>;
  setPromptRef?: React.RefObject<((text: string) => void) | null>;
  onEditorChange?: () => void;
}

/**
 * Editor refs (external or internal), the parent-facing `setPrompt` hook,
 * empty-state tracking and click-to-focus for the prompt box.
 */
export function usePromptEditorBindings({
  editorRef: externalEditorRef,
  editorContainerRef: externalEditorContainerRef,
  setPromptRef,
  onEditorChange,
}: UsePromptEditorBindingsParams) {
  const internalEditorRef = useRef<PromptEditorHandle>(null);
  const editorRef = externalEditorRef ?? internalEditorRef;
  const internalEditorContainerRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = externalEditorContainerRef ?? internalEditorContainerRef;
  const promptBoxRef = useRef<HTMLDivElement>(null);
  const [editorEmpty, setEditorEmpty] = useState(true);

  // ── Expose setPrompt to parent ──
  if (setPromptRef) {
    setPromptRef.current = (text: string) => {
      editorRef.current?.setContent(text);
    };
  }

  const handleEditorChange = useCallback(() => {
    setEditorEmpty(editorRef.current?.isEmpty() ?? true);
    onEditorChange?.();
  }, [onEditorChange, editorRef]);

  // ── Click-to-focus: click anywhere on the prompt box (except interactive elements) to focus editor ──
  const handlePromptBoxClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Don't steal focus from interactive elements
      if ((e.target as HTMLElement).closest(INTERACTIVE_SELECTOR)) return;
      editorRef.current?.focus();
    },
    [editorRef],
  );

  return {
    editorRef,
    editorContainerRef,
    promptBoxRef,
    editorEmpty,
    setEditorEmpty,
    handleEditorChange,
    handlePromptBoxClick,
  };
}

/** On desktop, return focus to the editor after a selection. On mobile, let the
 *  drawer restore its trigger so selection does not summon the keyboard. */
function useRefocusAfter<T>(
  callback: ((v: T) => void) | undefined,
  editorRef: React.RefObject<PromptEditorHandle | null>,
  isMobile: boolean,
) {
  return useCallback(
    (v: T) => {
      callback?.(v);
      if (!isMobile) requestAnimationFrame(() => editorRef.current?.focus());
    },
    [callback, editorRef, isMobile],
  );
}

function nextMode(modes: { value: string }[], mode: string): string {
  const idx = modes.findIndex((m) => m.value === mode);
  return modes[(idx + 1) % modes.length].value;
}

interface UseSelectorHandlersParams {
  editorRef: React.RefObject<PromptEditorHandle | null>;
  onUnifiedModelChange: (v: string) => void;
  onEffortChange?: (v: string) => void;
  onRuntimeChange?: (v: 'local' | 'remote') => void;
  mode: string;
  modes: { value: string }[];
  onModeChange: (v: string) => void;
}

/** Model / effort / runtime / mode selector callbacks. */
export function useSelectorHandlers({
  editorRef,
  onUnifiedModelChange,
  onEffortChange,
  onRuntimeChange,
  mode,
  modes,
  onModeChange,
}: UseSelectorHandlersParams) {
  const isMobile = useIsMobile();
  const handleUnifiedModelChange = useRefocusAfter(onUnifiedModelChange, editorRef, isMobile);
  const handleEffortChange = useRefocusAfter(onEffortChange, editorRef, isMobile);
  const handleRuntimeChange = useCallback(
    (v: string) => onRuntimeChange?.(v as 'local' | 'remote'),
    [onRuntimeChange],
  );
  const handleCycleMode = useCallback(
    () => onModeChange(nextMode(modes, mode)),
    [modes, mode, onModeChange],
  );
  return { handleUnifiedModelChange, handleEffortChange, handleRuntimeChange, handleCycleMode };
}

/** Image lightbox open/index state. */
export function useLightbox() {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const openAt = useCallback((i: number) => {
    setIndex(i);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  return { open, index, openAt, close };
}

/** Open state for the provider-setup and compact-confirm dialogs. */
export function usePromptDialogs() {
  // Compaction is irreversible (older messages get summarized), so confirm first.
  const [compactConfirmOpen, setCompactConfirmOpen] = useState(false);
  const [needsProviderSetup, setNeedsProviderSetup] = useState(false);
  return { compactConfirmOpen, setCompactConfirmOpen, needsProviderSetup, setNeedsProviderSetup };
}
