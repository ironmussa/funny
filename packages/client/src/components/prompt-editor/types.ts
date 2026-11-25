import type { JSONContent } from '@tiptap/react';

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

export interface PromptSlashResource {
  name: string;
  description?: string;
  kind: 'skill' | 'slash-command';
  scope?: 'global' | 'project';
  threadMode?: 'local' | 'worktree';
}

export interface PromptWorkflowResource {
  name: string;
  description?: string;
  source?: string;
}

export interface PromptEditorProps {
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

// ── Suggestion popup ─────────────────────────────────────────────

export interface SuggestionItem {
  id: string;
  label: string;
  path?: string;
  fileType?: 'file' | 'folder';
  description?: string;
  type: 'file' | 'slash' | 'skill' | 'symbol' | 'workflow';
  /** Symbol kind (function, class, etc.) — only for type='symbol' */
  symbolKind?: string;
  /** Line number in the file — only for type='symbol' */
  symbolLine?: number;
  /** End line number — only for type='symbol' */
  symbolEndLine?: number;
}

/** Which trigger opened the (single, shared) suggestion menu. */
export type SuggestionMenuType = 'file' | 'slash' | 'symbol' | 'workflow';
