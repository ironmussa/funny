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
import {
  FileText,
  FolderOpen,
  Zap,
  Loader2,
  Code2,
  Box,
  FileType,
  List,
  Variable,
  Sparkles,
} from 'lucide-react';
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
import { readFileMentionDragData } from '@/lib/file-mention-dnd';
import { metric } from '@/lib/telemetry';
import { middleTruncate } from '@/lib/text-truncate';
import { cn } from '@/lib/utils';

const SLASH_RESULTS_LIMIT = 50;

// Human-readable blurbs for the built-in SDK slash commands. The SDK reports
// command names but no descriptions, so we annotate the well-known ones; any
// other reported command falls back to a generic label.
const BUILTIN_SLASH_DESCRIPTIONS: Record<string, string> = {
  compact: 'Summarize the conversation to free up context',
  clear: 'Clear the conversation history',
  context: 'Show current context window usage',
  cost: 'Show token usage and cost for this session',
  init: 'Generate a CLAUDE.md for this project',
  review: 'Review a pull request',
  'pr-comments': 'Get comments from a GitHub pull request',
  'add-dir': 'Add a working directory to the session',
  'output-style': 'Change the agent output style',
  agents: 'Manage available subagents',
  mcp: 'Manage MCP server connections',
  memory: 'Edit memory files',
  vim: 'Toggle vim editing mode',
};
const BUILTIN_SLASH_FALLBACK = 'Built-in command';

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

interface SuggestionItem {
  id: string;
  label: string;
  path?: string;
  fileType?: 'file' | 'folder';
  description?: string;
  type: 'file' | 'slash' | 'skill' | 'symbol';
  /** Symbol kind (function, class, etc.) — only for type='symbol' */
  symbolKind?: string;
  /** Line number in the file — only for type='symbol' */
  symbolLine?: number;
  /** End line number — only for type='symbol' */
  symbolEndLine?: number;
}

interface SlashSuggestionOptions {
  skills: readonly (Pick<PromptSlashResource, 'name' | 'description'> &
    Partial<Pick<PromptSlashResource, 'kind'>>)[];
  sdkCommands: readonly string[];
  query: string;
  commandProvider?: string;
  limit?: number;
}

export function buildSlashSuggestionItems({
  skills,
  sdkCommands,
  query,
  commandProvider,
  limit = SLASH_RESULTS_LIMIT,
}: SlashSuggestionOptions): SuggestionItem[] {
  const skillByName = new Map(skills.map((s) => [s.name, s.description] as const));
  const sdkCommandNames = new Set(sdkCommands);

  // Build one ordered, de-duped candidate list so the SDK's built-in commands
  // (e.g. /compact) aren't crowded past the result cap by the long skills list.
  // Order: curated built-ins -> custom commands / skills -> any other SDK-reported command.
  const ordered: { name: string; description: string; type: 'slash' | 'skill' }[] = [];
  const seen = new Set<string>();
  const add = (name: string, description: string, type: 'slash' | 'skill') => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    ordered.push({ name, description, type });
  };
  // The curated descriptions are Claude Code's wording. Other providers
  // report their own /init, /compact, /review; use a neutral label there.
  const isClaude = commandProvider === 'claude';
  const builtinDesc = (name: string): string | undefined =>
    isClaude ? BUILTIN_SLASH_DESCRIPTIONS[name] : undefined;

  if (isClaude) {
    for (const name of sdkCommands) {
      if (BUILTIN_SLASH_DESCRIPTIONS[name]) add(name, BUILTIN_SLASH_DESCRIPTIONS[name], 'slash');
    }
  }
  for (const s of skills) {
    const type = s.kind === 'skill' && !sdkCommandNames.has(s.name) ? 'skill' : 'slash';
    add(s.name, s.description ?? (type === 'skill' ? 'Skill' : BUILTIN_SLASH_FALLBACK), type);
  }
  for (const name of sdkCommands) {
    add(name, skillByName.get(name) ?? builtinDesc(name) ?? BUILTIN_SLASH_FALLBACK, 'slash');
  }

  const q = query.toLowerCase();
  const matched: SuggestionItem[] = [];
  for (let i = 0; i < ordered.length && matched.length < limit; i++) {
    const o = ordered[i];
    if (o.name.toLowerCase().includes(q)) {
      matched.push({
        id: o.name,
        label: o.name,
        description: o.description,
        type: o.type,
      });
    }
  }
  return matched;
}

interface SuggestionPopupProps {
  items: SuggestionItem[];
  selectedIndex: number;
  loading?: boolean;
  truncated?: boolean;
  onSelect: (item: SuggestionItem) => void;
  onHover: (index: number) => void;
  rect: (() => DOMRect | null) | null;
  type: 'file' | 'slash' | 'symbol';
  /** Current search query for highlighting matches */
  query?: string;
  /** Ref to a container element — the popup will match its width and left edge */
  containerRef?: React.RefObject<HTMLElement | null>;
}

export function getSuggestionLoadingLabel(type: SuggestionPopupProps['type']) {
  if (type === 'file') {
    return { key: 'prompt.loadingFiles', fallback: 'Loading files...' };
  }
  if (type === 'symbol') {
    return { key: 'prompt.loadingSymbols', fallback: 'Loading symbols...' };
  }
  return { key: 'prompt.loadingCommands', fallback: 'Loading commands...' };
}

/** Icon for a symbol kind */
function SymbolKindIcon({ kind, className }: { kind?: string; className?: string }) {
  switch (kind) {
    case 'class':
      return <Box className={className} />;
    case 'interface':
    case 'type':
      return <FileType className={className} />;
    case 'enum':
      return <List className={className} />;
    case 'variable':
    case 'property':
      return <Variable className={className} />;
    default: // function, method, module
      return <Code2 className={className} />;
  }
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
    const loadingLabel = getSuggestionLoadingLabel(type);
    return createPortal(
      <div
        data-suggestion-popup
        style={style}
        className={cn(
          'max-h-52 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md',
          !containerRef?.current && 'w-80',
        )}
      >
        <div className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-xs">
          <Loader2 className="icon-xs animate-spin" />
          {t(loadingLabel.key, loadingLabel.fallback)}
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
        <div className="text-muted-foreground px-3 py-2 text-xs">
          {type === 'file'
            ? t('prompt.noFilesMatch', 'No files match')
            : type === 'symbol'
              ? t('prompt.noSymbolsMatch', 'No symbols match')
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
          type="button"
          key={`${item.type}:${item.id}`}
          data-testid={
            type === 'symbol'
              ? `symbol-item-${item.id}`
              : type === 'file'
                ? `mention-item-${item.id}`
                : `slash-item-${item.id}`
          }
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
          {type === 'symbol' ? (
            <SymbolKindIcon
              kind={item.symbolKind}
              className="icon-sm text-muted-foreground mt-0.5 shrink-0"
            />
          ) : type === 'file' ? (
            item.fileType === 'folder' ? (
              <FolderOpen className="icon-sm text-muted-foreground mt-0.5 shrink-0" />
            ) : (
              <FileText className="icon-sm text-muted-foreground mt-0.5 shrink-0" />
            )
          ) : item.type === 'skill' ? (
            <Sparkles className="icon-base text-muted-foreground mt-0.5 shrink-0" />
          ) : (
            <Zap className="icon-base text-muted-foreground mt-0.5 shrink-0" />
          )}
          <div className="min-w-0">
            <HighlightText
              text={
                type === 'slash'
                  ? `/${item.label}`
                  : type === 'symbol'
                    ? item.label
                    : middleTruncate(item.label)
              }
              query={query}
              className="block truncate font-mono text-xs font-medium"
            />
            {type === 'symbol' && item.path && (
              <span className="text-muted-foreground block truncate text-xs">
                {middleTruncate(item.path, 50)}
                {item.symbolLine ? `:${item.symbolLine}` : ''}
              </span>
            )}
            {item.description && (
              <HighlightText
                text={item.description}
                query={query}
                className="text-muted-foreground block truncate text-xs"
              />
            )}
          </div>
        </button>
      ))}
      {truncated && (
        <div className="border-border text-muted-foreground border-t px-3 py-1.5 text-xs">
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
    onFileMentionDrop,
    cwd,
    slashSkills,
    slashSkillsLoading,
    onSlashOpen,
    sdkSlashCommands,
    commandProvider,
    className,
    containerRef,
  },
  ref,
) {
  // ── Suggestion state (shared for both @ and /) ──
  const [suggestionType, setSuggestionType] = useState<'file' | 'slash' | 'symbol' | null>(null);
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
  // Slash skills come from the owner (single source of truth) — mirror them
  // into refs for synchronous reads inside the TipTap suggestion callbacks.
  const slashSkillsRef = useRef<readonly PromptSlashResource[]>(slashSkills ?? []);
  slashSkillsRef.current = slashSkills ?? [];
  const slashSkillsLoadingRef = useRef(slashSkillsLoading);
  slashSkillsLoadingRef.current = slashSkillsLoading;
  const onSlashOpenRef = useRef(onSlashOpen);
  onSlashOpenRef.current = onSlashOpen;
  // Keep cwd ref current for async callbacks
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const sdkSlashCommandsRef = useRef(sdkSlashCommands);
  sdkSlashCommandsRef.current = sdkSlashCommands;
  const commandProviderRef = useRef(commandProvider);
  commandProviderRef.current = commandProvider;

  // Refs for suggestion state accessed inside closures captured at editor creation time
  const suggestionItemsRef = useRef(suggestionItems);
  suggestionItemsRef.current = suggestionItems;
  const suggestionTypeRef = useRef(suggestionType);
  suggestionTypeRef.current = suggestionType;
  const suggestionQueryRef = useRef(suggestionQuery);
  suggestionQueryRef.current = suggestionQuery;

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
      allowedPrefixes: [' ', '\n'],
      items: ({ query }: { query: string }) => {
        // Use the full text after @ (up to next space) instead of TipTap's
        // caret-dependent query, so moving the caret doesn't change results
        const fullQuery = getFullQuery(query);
        // Defer state updates out of TipTap's render cycle to avoid
        // "Cannot update a component while rendering a different component"
        queueMicrotask(() => {
          setSuggestionQuery(fullQuery);
          setSuggestionLoading(true);
        });
        // Return a promise that resolves with items after debounce
        return new Promise<SuggestionItem[]>((resolve) => {
          if (fileTimerRef.current) clearTimeout(fileTimerRef.current);
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
  const applySlashSuggestionItems = useCallback((items: SuggestionItem[]) => {
    setSuggestionItems((prev) => {
      const changed =
        prev.length !== items.length || prev.some((item, i) => item.id !== items[i]?.id);
      if (changed) setSuggestionIndex(0);
      return items;
    });
  }, []);

  // Rebuild the open `/` menu whenever the owner's resolved skills, the SDK
  // commands, or the provider change — so a late eager-load, a lazy first
  // fetch, or a model/provider switch is reflected without re-opening the menu.
  // This replaces the editor's old internal skills cache.
  useEffect(() => {
    if (suggestionType !== 'slash') return;
    setSuggestionLoading(Boolean(slashSkillsLoading) && (slashSkills?.length ?? 0) === 0);
    applySlashSuggestionItems(
      buildSlashSuggestionItems({
        skills: slashSkills ?? [],
        sdkCommands: sdkSlashCommands ?? [],
        query: suggestionQueryRef.current,
        commandProvider,
      }),
    );
  }, [
    suggestionType,
    slashSkills,
    slashSkillsLoading,
    sdkSlashCommands,
    commandProvider,
    applySlashSuggestionItems,
  ]);

  const slashSuggestion = useCallback(
    () => ({
      char: '/',
      allowSpaces: false,
      allowedPrefixes: [' ', '\n'],
      items: ({ query }: { query: string }) => {
        const fullQuery = getFullQuery(query);
        // Defer state updates out of TipTap's render cycle
        queueMicrotask(() => setSuggestionQuery(fullQuery));
        // Lazy owners begin their fetch here; eager owners no-op. The reactive
        // effect above rebuilds the menu once the resolved skills arrive.
        onSlashOpenRef.current?.();
        const t0 = performance.now();
        const skills = slashSkillsRef.current;
        const sdkCommands = sdkSlashCommandsRef.current ?? [];
        const matched = buildSlashSuggestionItems({
          skills,
          sdkCommands,
          query: fullQuery,
          commandProvider: commandProviderRef.current,
        });
        metric('palette.slash.filter_ms', performance.now() - t0, {
          type: 'gauge',
          attributes: {
            query_len: String(fullQuery.length),
            total: String(skills.length + sdkCommands.length),
            matched: String(matched.length),
          },
        });
        return matched;
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
    [getFullQuery],
  );

  // ── Symbol suggestion config (# trigger) ──
  const symbolTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const symbolSuggestion = useCallback(
    () => ({
      char: '#',
      allowSpaces: false,
      allowedPrefixes: [' ', '\n'],
      items: ({ query }: { query: string }) => {
        const fullQuery = getFullQuery(query);
        // Defer state updates out of TipTap's render cycle
        queueMicrotask(() => {
          setSuggestionQuery(fullQuery);
          setSuggestionLoading(true);
        });
        return new Promise<SuggestionItem[]>((resolve) => {
          if (symbolTimerRef.current) clearTimeout(symbolTimerRef.current);
          symbolTimerRef.current = setTimeout(async () => {
            const path = cwdRef.current;
            if (!path) {
              setSuggestionLoading(false);
              resolve([]);
              return;
            }
            // Support #file:symbol syntax
            const [fileScope, symbolQuery] = fullQuery.includes(':')
              ? [fullQuery.split(':')[0], fullQuery.split(':').slice(1).join(':')]
              : [undefined, fullQuery];

            const result = await api.searchSymbols(path, symbolQuery || undefined, fileScope);
            let items: SuggestionItem[] = [];
            if (result.isOk()) {
              items = result.value.symbols.map((s) => ({
                id: `${s.filePath}:${s.name}:${s.line}`,
                label: s.containerName ? `${s.containerName}.${s.name}` : s.name,
                path: s.filePath,
                symbolKind: s.kind,
                symbolLine: s.line,
                symbolEndLine: s.endLine,
                type: 'symbol' as const,
              }));
              setSuggestionTruncated(result.value.truncated);

              // If not indexed yet, trigger indexing
              if (!result.value.indexed) {
                api.triggerSymbolIndex(path);
              }
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
              type: 'symbolMention',
              attrs: {
                id: props.id,
                label: props.label,
                path: props.path ?? '',
                kind: props.symbolKind ?? 'function',
                line: props.symbolLine ?? 0,
                endLine: props.symbolEndLine,
              },
            },
            { type: 'text', text: ' ' },
          ])
          .run();
      },
      render: () => ({
        onStart: (props: any) => {
          triggerPosRef.current = props.range?.from ?? null;
          setSuggestionType('symbol');
          setSuggestionItems(props.items);
          setSuggestionIndex(0);
          setSuggestionQuery(props.query ?? '');
          setSuggestionRect(() => props.clientRect);
          suggestionCommandRef.current = props.command;
        },
        onUpdate: (props: any) => {
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
          setSuggestionTruncated(false);
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
  const onFileMentionDropRef = useRef(onFileMentionDrop);
  onFileMentionDropRef.current = onFileMentionDrop;

  const editor = useEditor({
    immediatelyRender: true,
    autofocus: 'end',
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
      // Symbol mentions (# trigger)
      Mention.extend({
        name: 'symbolMention',
        addAttributes() {
          return {
            ...this.parent?.(),
            path: { default: null },
            kind: { default: 'function' },
            line: { default: 0 },
            endLine: { default: null },
          };
        },
        renderHTML({ node, HTMLAttributes }) {
          return [
            'span',
            {
              ...HTMLAttributes,
              class: 'symbol-mention',
              'data-symbol-kind': node.attrs.kind || 'function',
            },
            node.attrs.label || node.attrs.id,
          ];
        },
      }).configure({
        HTMLAttributes: { class: 'symbol-mention' },
        suggestion: symbolSuggestion(),
        deleteTriggerWithBackspace: true,
      }),
    ],
    editorProps: {
      attributes: {
        'data-testid': 'prompt-editor',
        'aria-label': 'Message',
        class:
          'w-full resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-hidden min-h-[3.75rem] max-h-[35vh] overflow-y-auto',
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
      handleDrop: (view, event) => {
        const dt = (event as DragEvent).dataTransfer;
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
          left: (event as DragEvent).clientX,
          top: (event as DragEvent).clientY,
        });
        const insertAt = dropPos ? dropPos.pos : view.state.selection.from;
        const tr = view.state.tr.insert(insertAt, [node, space]);
        const after = insertAt + node.nodeSize + space.nodeSize;
        tr.setSelection(TextSelection.create(tr.doc, after));
        view.dispatch(tr);
        view.focus();
        onFileMentionDropRef.current?.();
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      onChangeRef.current?.();
      // Keep the caret in view — PM's scrollIntoView can lag behind our height
      // animation, so we re-assert it on the next frame.
      requestAnimationFrame(() => {
        try {
          const dom = ed.view.dom as HTMLElement;
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
    },
    editable: !disabled,
  });
  editorRef.current = editor;

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
        if (!alive(editor)) return;
        editor.chain().focus().insertContent(text).run();
      },
      setDictationPreview: (text: string) => {
        if (!alive(editor)) return;
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
        if (!alive(editor)) return;
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
      endDictation: () => {
        dictationRangeRef.current = null;
      },
    }),
    [editor],
  );

  // ── Handle suggestion item selection from the popup ──
  const handleSuggestionSelect = useCallback((item: SuggestionItem) => {
    suggestionCommandRef.current?.(item as unknown as Record<string, unknown>);
  }, []);

  // ── Animate height changes when text wraps to a new line ──
  useEffect(() => {
    if (!editor) return;
    let el: HTMLElement | undefined;
    try {
      el = editor.view.dom as HTMLElement;
    } catch {
      return;
    }
    if (!el) return;
    let prev = el.offsetHeight;
    let anim: Animation | null = null;
    const ro = new ResizeObserver(() => {
      if (anim?.playState === 'running') return; // skip self-triggered fires
      const next = el.offsetHeight;
      if (next === prev) return;
      const prevOverflow = el.style.overflowY;
      el.style.overflowY = 'hidden';
      anim = el.animate(
        { height: [`${prev}px`, `${next}px`] },
        { duration: 150, easing: 'ease-out' },
      );
      anim.onfinish = anim.oncancel = () => {
        el.style.overflowY = prevOverflow;
      };
      prev = next;
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      anim?.cancel();
    };
  }, [editor]);

  // ── Close suggestion popup on click outside ──
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
          truncated={
            suggestionType === 'file' || suggestionType === 'symbol' ? suggestionTruncated : false
          }
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
