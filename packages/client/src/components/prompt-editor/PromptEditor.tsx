import type { Skill } from '@funny/shared';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import History from '@tiptap/extension-history';
import Mention from '@tiptap/extension-mention';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Text from '@tiptap/extension-text';
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
}: SuggestionPopupProps) {
  const { t } = useTranslation();
  const popupRef = useRef<HTMLDivElement>(null);

  // Compute position synchronously to avoid flash/jump.
  // We recalculate on every render that changes rect or items.
  const style = useMemo<React.CSSProperties>(() => {
    if (!rect) return { position: 'fixed', visibility: 'hidden' as const, zIndex: 50 };
    const r = rect();
    if (!r) return { position: 'fixed', visibility: 'hidden' as const, zIndex: 50 };
    return {
      position: 'fixed',
      left: r.left,
      bottom: window.innerHeight - r.top + 4,
      zIndex: 50,
    };
  }, [rect]);

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
        style={style}
        className="max-h-52 w-80 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
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
        style={style}
        className="max-h-52 w-80 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
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
      style={style}
      className="max-h-52 w-80 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
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
            <div className="truncate font-mono text-xs font-medium">
              {type === 'slash' ? `/${item.label}` : item.label}
            </div>
            {item.description && (
              <div className="truncate text-xs text-muted-foreground">{item.description}</div>
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
  { placeholder, disabled, onSubmit, onCycleMode, onChange, onPaste, cwd, loadSkills, className },
  ref,
) {
  // ── Suggestion state (shared for both @ and /) ──
  const [suggestionType, setSuggestionType] = useState<'file' | 'slash' | null>(null);
  const [suggestionItems, setSuggestionItems] = useState<SuggestionItem[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionTruncated, setSuggestionTruncated] = useState(false);
  const [suggestionRect, setSuggestionRect] = useState<(() => DOMRect | null) | null>(null);
  const suggestionCommandRef = useRef<((props: Record<string, unknown>) => void) | null>(null);

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

  // ── File suggestion config ──
  const fileSuggestion = useCallback(
    () => ({
      char: '@',
      allowSpaces: false,
      items: ({ query }: { query: string }) => {
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
            const result = await api.browseFiles(path, query || undefined);
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
          setSuggestionType('file');
          setSuggestionItems(props.items);
          setSuggestionIndex(0);
          setSuggestionRect(() => props.clientRect);
          suggestionCommandRef.current = props.command;
        },
        onUpdate: (props: any) => {
          setSuggestionItems(props.items);
          setSuggestionIndex(0);
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
          setSuggestionType(null);
          setSuggestionItems([]);
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
      items: async ({ query }: { query: string }) => {
        if (!skillsCacheRef.current) {
          setSuggestionLoading(true);
          const fn = loadSkillsRef.current;
          skillsCacheRef.current = fn ? await fn() : [];
          setSuggestionLoading(false);
        }
        const skills = skillsCacheRef.current ?? [];
        const q = query.toLowerCase();
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
          setSuggestionType('slash');
          setSuggestionItems(props.items);
          setSuggestionIndex(0);
          setSuggestionRect(() => props.clientRect);
          suggestionCommandRef.current = props.command;
        },
        onUpdate: (props: any) => {
          setSuggestionItems(props.items);
          setSuggestionIndex(0);
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
          setSuggestionType(null);
          setSuggestionItems([]);
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
      }),
    ],
    editorProps: {
      attributes: {
        'data-testid': 'prompt-editor',
        'aria-label': 'Message',
        class:
          'w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none min-h-[1.5rem] max-h-[35vh] overflow-y-auto',
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
    }),
    [editor],
  );

  // ── Handle suggestion item selection from the popup ──
  const handleSuggestionSelect = useCallback((item: SuggestionItem) => {
    suggestionCommandRef.current?.(item as unknown as Record<string, unknown>);
  }, []);

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
        />
      )}
    </>
  );
});
