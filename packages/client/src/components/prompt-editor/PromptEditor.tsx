import type { Skill } from '@funny/shared';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import History from '@tiptap/extension-history';
import Mention from '@tiptap/extension-mention';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Text from '@tiptap/extension-text';
import { TextSelection } from '@tiptap/pm/state';
import type { JSONContent } from '@tiptap/react';
import { EditorContent, useEditor } from '@tiptap/react';
import { FileText, FolderOpen, Zap, Loader2 } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { HighlightText } from '@/components/ui/highlight-text';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

// ── Types ────────────────────────────────────────────────────────

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
}

interface PromptEditorProps {
  placeholder?: string;
  disabled?: boolean;
  /** Called on Enter (without Shift) */
  onSubmit?: () => void;
  /** Called on Shift+Tab to cycle permission mode */
  onCycleMode?: () => void;
  /** Called when content changes */
  onChange?: () => void;
  /** Called when image is pasted */
  onPaste?: (e: ClipboardEvent) => void;
  /** Effective cwd for file browsing */
  cwd?: string;
  /** Callback to load skills on first / trigger */
  loadSkills?: () => Promise<Skill[]>;
  className?: string;
  /** Ref to the outer container — suggestion popup will match its width */
  containerRef?: React.RefObject<HTMLElement | null>;
}

// ── Suggestion popup ─────────────────────────────────────────────

interface SuggestionItem {
  id: string;
  label: string;
  path?: string;
  fileType?: 'file' | 'folder';
  description?: string;
  type: 'file' | 'slash';
}

interface SuggestionPopupProps {
  items: SuggestionItem[];
  selectedIndex: number;
  loading?: boolean;
  truncated?: boolean;
  onSelect: (item: SuggestionItem) => void;
  onHover: (index: number) => void;
  rect: (() => DOMRect | null) | null;
  type: 'file' | 'slash';
  /** Current search query for highlighting matches */
  query?: string;
  /** Ref to a container element — the popup will match its width and left edge */
  containerRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Truncate a file path in the middle so that the first directory and the
 * file name are always visible:  `frontend-v1/src/\u2026/venues-create-info.component.html`
 */
function middleTruncate(path: string, maxLen = 60): string {
  if (path.length <= maxLen) return path;
  const sep = '/';
  const parts = path.split(sep);
  if (parts.length <= 2) return path;

  // Always keep the file name (last part)
  const fileName = parts[parts.length - 1];
  // Budget for the prefix (everything before the ellipsis)
  const prefixBudget = maxLen - fileName.length - 4; // 4 = "/\u2026/"
  if (prefixBudget <= 0) return '\u2026' + sep + fileName;

  // Build prefix from the left until we exceed the budget
  let prefix = '';
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = prefix ? prefix + sep + parts[i] : parts[i];
    if (candidate.length > prefixBudget) break;
    prefix = candidate;
  }

  return (prefix ? prefix + sep : '') + '\u2026' + sep + fileName;
}

function SuggestionPopup({
  items,
  selectedIndex,
  loading,
  truncated,
  onSelect,
  onHover,
  rect,
  type,
  query = '',
  containerRef,
}: SuggestionPopupProps) {
  const { t } = useTranslation();
  const popupRef = useRef<HTMLDivElement>(null);

  // Compute position synchronously to avoid flash/jump.
  // We recalculate on every render that changes rect or items.
  const style = useMemo<React.CSSProperties>(() => {
    if (!rect) return { position: 'fixed', visibility: 'hidden' as const, zIndex: 50 };
    const r = rect();
    if (!r) return { position: 'fixed', visibility: 'hidden' as const, zIndex: 50 };
    // If a container ref is provided, match its left edge and width
    const container = containerRef?.current;
    const containerRect = container?.getBoundingClientRect();
    return {
      position: 'fixed',
      left: containerRect ? containerRect.left : r.left,
      width: containerRect ? containerRect.width : undefined,
      // Align the popup's bottom edge to the top of the container (or cursor)
      bottom: window.innerHeight - (containerRect ? containerRect.top : r.top) + 4,
      zIndex: 50,
    };
  }, [rect, containerRef]);

  // Scroll selected into view — use scrollTop manipulation instead of
  // scrollIntoView which can scroll parent containers and cause jumps.
  useEffect(() => {
    const container = popupRef.current;
    if (!container) return;
    const el = container.children[selectedIndex] as HTMLElement | undefined;
    if (!el) return;
    const elTop = el.offsetTop;
    const elBottom = elTop + el.offsetHeight;
    if (elTop < container.scrollTop) {
      container.scrollTop = elTop;
    } else if (elBottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = elBottom - container.clientHeight;
    }
  }, [selectedIndex]);

  if (loading && items.length === 0) {
    return createPortal(
      <div
        data-suggestion-popup
        style={style}
        className={cn(
          'max-h-52 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md',
          !containerRef?.current && 'w-80',
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {type === 'file'
            ? t('prompt.loadingFiles', 'Loading files\u2026')
            : t('prompt.loadingSkills', 'Loading skills\u2026')}
        </div>
      </div>,
      document.body,
    );
  }

  if (items.length === 0) {
    return createPortal(
      <div
        data-suggestion-popup
        style={style}
        className={cn(
          'max-h-52 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md',
          !containerRef?.current && 'w-80',
        )}
      >
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {type === 'file'
            ? t('prompt.noFilesMatch', 'No files match')
            : t('skills.noSkillsFound', 'No skills found')}
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={popupRef}
      data-suggestion-popup
      style={style}
      className={cn(
        'max-h-52 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md',
        !containerRef?.current && 'w-80',
      )}
    >
      {items.map((item, i) => (
        <button
          key={`${item.type}:${item.id}`}
          data-testid={type === 'file' ? `mention-item-${item.id}` : `slash-item-${item.id}`}
          className={cn(
            'flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent',
            i === selectedIndex && 'bg-accent',
          )}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(item);
          }}
          onMouseEnter={() => onHover(i)}
        >
          {type === 'file' ? (
            item.fileType === 'folder' ? (
              <FolderOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )
          ) : (
            <Zap className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <HighlightText
              text={type === 'slash' ? `/${item.label}` : middleTruncate(item.label)}
              query={query}
              className="block truncate font-mono text-xs font-medium"
            />
            {item.description && (
              <HighlightText
                text={item.description}
                query={query}
                className="block truncate text-xs text-muted-foreground"
              />
            )}
          </div>
        </button>
      ))}
      {truncated && (
        <div className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          {t('prompt.moreFilesHint', 'Type to narrow results\u2026')}
        </div>
      )}
    </div>,
    document.body,
  );
}

// ── PromptEditor ─────────────────────────────────────────────────

export const PromptEditor = forwardRef<PromptEditorHandle, PromptEditorProps>(function PromptEditor(
  {
    placeholder,
    disabled,
    onSubmit,
    onCycleMode,
    onChange,
    onPaste,
    cwd,
    loadSkills,
    className,
    containerRef,
  },
  ref,
) {
  // ── Suggestion state (shared for both @ and /) ──
  const [suggestionType, setSuggestionType] = useState<'file' | 'slash' | null>(null);
  const [suggestionItems, setSuggestionItems] = useState<SuggestionItem[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionTruncated, setSuggestionTruncated] = useState(false);
  const [suggestionQuery, setSuggestionQuery] = useState('');
  const [suggestionRect, setSuggestionRect] = useState<(() => DOMRect | null) | null>(null);
  const suggestionCommandRef = useRef<((props: Record<string, unknown>) => void) | null>(null);

  // Dictation partial tracking: [startPos, endPos] in the document
  const dictationRangeRef = useRef<{ from: number; to: number } | null>(null);

  // Debounce timer for file fetching
  const fileTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Cached skills
  const skillsCacheRef = useRef<Skill[] | null>(null);
  // Keep cwd/loadSkills refs current for async callbacks
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const loadSkillsRef = useRef(loadSkills);
  loadSkillsRef.current = loadSkills;

  // Refs for suggestion state accessed inside closures captured at editor creation time
  const suggestionItemsRef = useRef(suggestionItems);
  suggestionItemsRef.current = suggestionItems;
  const suggestionTypeRef = useRef(suggestionType);
  suggestionTypeRef.current = suggestionType;

  // Track the trigger position so we can read the full query (@ to next space/EOL)
  // regardless of caret position
  const triggerPosRef = useRef<number | null>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);

  /**
   * Read the full text after a trigger character (@ or /) up to the next
   * whitespace or end of the text node, regardless of caret position.
   * Falls back to TipTap's query if the editor isn't available.
   */
  const getFullQuery = useCallback((tiptapQuery: string): string => {
    const ed = editorRef.current;
    const triggerFrom = triggerPosRef.current;
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
  }, []);

  // ── File suggestion config ──
  const fileSuggestion = useCallback(
    () => ({
      char: '@',
      allowSpaces: false,
      allowedPrefixes: null,
      items: ({ query }: { query: string }) => {
        // Use the full text after @ (up to next space) instead of TipTap's
        // caret-dependent query, so moving the caret doesn't change results
        const fullQuery = getFullQuery(query);
        setSuggestionQuery(fullQuery);
        // Return a promise that resolves with items after debounce
        return new Promise<SuggestionItem[]>((resolve) => {
          if (fileTimerRef.current) clearTimeout(fileTimerRef.current);
          setSuggestionLoading(true);
          fileTimerRef.current = setTimeout(async () => {
            const path = cwdRef.current;
            if (!path) {
              setSuggestionLoading(false);
              resolve([]);
              return;
            }
            const result = await api.browseFiles(path, fullQuery || undefined);
            let items: SuggestionItem[] = [];
            if (result.isOk()) {
              items = result.value.files.map((f) => {
                const file = typeof f === 'string' ? { path: f, type: 'file' as const } : f;
                return {
                  id: file.path,
                  label: file.path,
                  path: file.path,
                  fileType: file.type,
                  type: 'file' as const,
                };
              });
              setSuggestionTruncated(result.value.truncated);
            }
            setSuggestionLoading(false);
            resolve(items);
          }, 150);
        });
      },
      command: ({ editor, range, props }: any) => {
        const docSize = editor.state.doc.content.size;
        const safeRange = {
          from: Math.min(range.from, docSize),
          to: Math.min(range.to, docSize),
        };
        editor
          .chain()
          .focus()
          .insertContentAt(safeRange, [
            {
              type: 'fileMention',
              attrs: {
                id: props.path ?? props.id,
                label: (props.label as string).split('/').pop() ?? props.label,
                path: props.path ?? props.id,
                fileType: props.fileType ?? 'file',
              },
            },
            { type: 'text', text: ' ' },
          ])
          .run();
      },
      render: () => ({
        onStart: (props: any) => {
          triggerPosRef.current = props.range?.from ?? null;
          setSuggestionType('file');
          setSuggestionItems(props.items);
          setSuggestionIndex(0);
          setSuggestionQuery(props.query ?? '');
          setSuggestionRect(() => props.clientRect);
          suggestionCommandRef.current = props.command;
        },
        onUpdate: (props: any) => {
          // Only reset the selected index when items actually change
          setSuggestionItems((prev) => {
            const next = props.items as SuggestionItem[];
            const changed =
              prev.length !== next.length || prev.some((item, i) => item.id !== next[i]?.id);
            if (changed) setSuggestionIndex(0);
            return next;
          });
          setSuggestionQuery(getFullQuery(props.query ?? ''));
          setSuggestionRect(() => props.clientRect);
          suggestionCommandRef.current = props.command;
        },
        onKeyDown: (props: any) => {
          const { event } = props;
          const len = suggestionItemsRef.current.length;
          if (event.key === 'ArrowDown') {
            setSuggestionIndex((i) => (i + 1) % Math.max(1, len));
            return true;
          }
          if (event.key === 'ArrowUp') {
            setSuggestionIndex((i) => (i - 1 + Math.max(1, len)) % Math.max(1, len));
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const items = suggestionItemsRef.current;
            if (items.length > 0) {
              // Use setSuggestionIndex to read the latest index, then select
              setSuggestionIndex((currentIndex) => {
                const item = items[currentIndex];
                if (item) {
                  suggestionCommandRef.current?.(item as unknown as Record<string, unknown>);
                }
                return currentIndex;
              });
            }
            return true;
          }
          if (event.key === 'Escape') {
            setSuggestionType(null);
            return true;
          }
          return false;
        },
        onExit: () => {
          triggerPosRef.current = null;
          setSuggestionType(null);
          setSuggestionItems([]);
          setSuggestionQuery('');
          setSuggestionLoading(false);
          setSuggestionTruncated(false);
        },
      }),
    }),
    // Intentionally empty: cwd/loadSkills accessed via refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── Slash command suggestion config ──
  const slashSuggestion = useCallback(
    () => ({
      char: '/',
      allowSpaces: false,
      allowedPrefixes: [' ', '\n'],
      items: async ({ query }: { query: string }) => {
        const fullQuery = getFullQuery(query);
        setSuggestionQuery(fullQuery);
        if (!skillsCacheRef.current) {
          setSuggestionLoading(true);
          const fn = loadSkillsRef.current;
          skillsCacheRef.current = fn ? await fn() : [];
          setSuggestionLoading(false);
        }
        const skills = skillsCacheRef.current ?? [];
        const q = fullQuery.toLowerCase();
        return skills
          .filter((s) => s.name.toLowerCase().includes(q))
          .map((s) => ({
            id: s.name,
            label: s.name,
            description: s.description,
            type: 'slash' as const,
          }));
      },
      command: ({ editor, range, props }: any) => {
        const docSize = editor.state.doc.content.size;
        const safeRange = {
          from: Math.min(range.from, docSize),
          to: Math.min(range.to, docSize),
        };
        editor
          .chain()
          .focus()
          .insertContentAt(safeRange, [
            {
              type: 'slashCommand',
              attrs: {
                id: props.id,
                label: props.label,
              },
            },
            { type: 'text', text: ' ' },
          ])
          .run();
      },
      render: () => ({
        onStart: (props: any) => {
          triggerPosRef.current = props.range?.from ?? null;
          setSuggestionType('slash');
          setSuggestionItems(props.items);
          setSuggestionIndex(0);
          setSuggestionQuery(props.query ?? '');
          setSuggestionRect(() => props.clientRect);
          suggestionCommandRef.current = props.command;
        },
        onUpdate: (props: any) => {
          // Only reset the selected index when items actually change
          setSuggestionItems((prev) => {
            const next = props.items as SuggestionItem[];
            const changed =
              prev.length !== next.length || prev.some((item, i) => item.id !== next[i]?.id);
            if (changed) setSuggestionIndex(0);
            return next;
          });
          setSuggestionQuery(getFullQuery(props.query ?? ''));
          setSuggestionRect(() => props.clientRect);
          suggestionCommandRef.current = props.command;
        },
        onKeyDown: (props: any) => {
          const { event } = props;
          const len = suggestionItemsRef.current.length;
          if (event.key === 'ArrowDown') {
            setSuggestionIndex((i) => (i + 1) % Math.max(1, len));
            return true;
          }
          if (event.key === 'ArrowUp') {
            setSuggestionIndex((i) => (i - 1 + Math.max(1, len)) % Math.max(1, len));
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const items = suggestionItemsRef.current;
            if (items.length > 0) {
              setSuggestionIndex((currentIndex) => {
                const item = items[currentIndex];
                if (item) {
                  suggestionCommandRef.current?.(item as unknown as Record<string, unknown>);
                }
                return currentIndex;
              });
            }
            return true;
          }
          if (event.key === 'Escape') {
            setSuggestionType(null);
            return true;
          }
          return false;
        },
        onExit: () => {
          triggerPosRef.current = null;
          setSuggestionType(null);
          setSuggestionItems([]);
          setSuggestionQuery('');
          setSuggestionLoading(false);
        },
      }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── TipTap editor ──
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onCycleModeRef = useRef(onCycleMode);
  onCycleModeRef.current = onCycleMode;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    immediatelyRender: true,
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      History,
      Placeholder.configure({ placeholder: placeholder ?? '' }),
      // File mentions (@ trigger)
      Mention.extend({
        name: 'fileMention',
        addAttributes() {
          return {
            ...this.parent?.(),
            path: { default: null },
            fileType: { default: 'file' },
          };
        },
        renderHTML({ node, HTMLAttributes }) {
          const fileType = node.attrs.fileType || 'file';
          return [
            'span',
            {
              ...HTMLAttributes,
              class: 'file-mention',
              'data-file-type': fileType,
            },
            node.attrs.label || node.attrs.id,
          ];
        },
      }).configure({
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
    ],
    editorProps: {
      attributes: {
        'data-testid': 'prompt-editor',
        'aria-label': 'Message',
        class:
          'w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none min-h-[1.5rem] max-h-[35vh] overflow-y-auto',
        role: 'textbox',
      },
      handleKeyDown: (_view, event) => {
        // Shift+Tab: cycle permission mode
        if (event.key === 'Tab' && event.shiftKey) {
          event.preventDefault();
          onCycleModeRef.current?.();
          return true;
        }
        // Enter without shift → submit
        if (event.key === 'Enter' && !event.shiftKey) {
          // If a suggestion popup is open, let the suggestion handle it
          if (suggestionTypeRef.current) return false;
          event.preventDefault();
          onSubmitRef.current?.();
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        // Check for images in the clipboard
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            event.preventDefault();
            onPaste?.(event as unknown as ClipboardEvent);
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: () => {
      onChangeRef.current?.();
    },
    editable: !disabled,
  });
  editorRef.current = editor;

  // Update placeholder when it changes
  useEffect(() => {
    if (!editor) return;
    editor.extensionManager.extensions.forEach((ext) => {
      if (ext.name === 'placeholder') {
        (ext.options as any).placeholder = placeholder ?? '';
        editor.view.dispatch(editor.state.tr);
      }
    });
  }, [editor, placeholder]);

  // Update editable state
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  // ── Imperative handle ──
  useImperativeHandle(
    ref,
    () => ({
      getJSON: () => editor?.getJSON(),
      setContent: (content: JSONContent | string) => {
        if (!editor) return;
        if (typeof content === 'string') {
          editor.commands.setContent(content ? `<p>${content}</p>` : '');
        } else {
          editor.commands.setContent(content);
        }
      },
      getText: () => editor?.getText() ?? '',
      focus: () => editor?.commands.focus(),
      clear: () => editor?.commands.clearContent(),
      isEmpty: () => editor?.isEmpty ?? true,
      insertFileMention: (path: string, fileType: 'file' | 'folder') => {
        if (!editor) return;
        const label = path.split('/').pop() ?? path;
        editor
          .chain()
          .focus()
          .insertContent([
            {
              type: 'fileMention',
              attrs: { id: path, label, path, fileType },
            },
            { type: 'text', text: ' ' },
          ])
          .run();
      },
      insertText: (text: string) => {
        if (!editor) return;
        editor.chain().focus().insertContent(text).run();
      },
      setDictationPreview: (text: string) => {
        if (!editor) return;
        const { state } = editor;
        const range = dictationRangeRef.current;

        // Clamp range to valid document positions
        const docSize = state.doc.content.size;
        const safeFrom = range ? Math.min(Math.max(range.from, 0), docSize) : null;
        const safeTo = range ? Math.min(Math.max(range.to, 0), docSize) : null;

        let insertFrom: number;

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
            insertFrom = safeFrom;
          } else {
            // Range is invalid/empty — just insert at cursor
            const from = state.selection.from;
            const tr = state.tr.insertText(text, from);
            editor.view.dispatch(tr);
            insertFrom = from;
          }
        } else {
          // First partial — insert at current cursor
          const from = state.selection.from;
          const tr = state.tr.insertText(text, from);
          editor.view.dispatch(tr);
          insertFrom = from;
        }

        dictationRangeRef.current = { from: insertFrom, to: insertFrom + text.length };
      },
      commitDictation: (text: string) => {
        if (!editor) return;
        const { state } = editor;
        const range = dictationRangeRef.current;
        const finalText = text + ' ';

        const docSize = state.doc.content.size;
        const safeFrom = range ? Math.min(Math.max(range.from, 0), docSize) : null;
        const safeTo = range ? Math.min(Math.max(range.to, 0), docSize) : null;

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

        dictationRangeRef.current = null;
      },
    }),
    [editor],
  );

  // ── Handle suggestion item selection from the popup ──
  const handleSuggestionSelect = useCallback((item: SuggestionItem) => {
    suggestionCommandRef.current?.(item as unknown as Record<string, unknown>);
  }, []);

  // ── Close suggestion popup on click outside ──
  useEffect(() => {
    if (!suggestionType) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // Check if click is inside the editor
      if (editor?.view.dom.contains(target)) return;
      // Check if click is inside the popup (portaled to body)
      const popup = document.querySelector('[data-suggestion-popup]');
      if (popup?.contains(target)) return;
      // Click is outside — dismiss the suggestion
      setSuggestionType(null);
      setSuggestionItems([]);
      setSuggestionLoading(false);
      setSuggestionTruncated(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [suggestionType, editor]);

  return (
    <>
      <EditorContent editor={editor} className={cn('tiptap-prompt-editor', className)} />
      {suggestionType && (
        <SuggestionPopup
          items={suggestionItems}
          selectedIndex={suggestionIndex}
          loading={suggestionLoading}
          truncated={suggestionType === 'file' ? suggestionTruncated : false}
          onSelect={handleSuggestionSelect}
          onHover={setSuggestionIndex}
          rect={suggestionRect}
          type={suggestionType}
          query={suggestionQuery}
          containerRef={containerRef}
        />
      )}
    </>
  );
});
