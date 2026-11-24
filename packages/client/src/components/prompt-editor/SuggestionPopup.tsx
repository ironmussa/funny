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
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { HighlightText } from '@/components/ui/highlight-text';
import { middleTruncate } from '@/lib/text-truncate';
import { cn } from '@/lib/utils';

import {
  getSuggestionLoadingLabel,
  type SuggestionItem,
  type SuggestionMenuType,
} from './suggestion-items';

interface SuggestionPopupProps {
  items: SuggestionItem[];
  selectedIndex: number;
  loading?: boolean;
  truncated?: boolean;
  onSelect: (item: SuggestionItem) => void;
  onHover: (index: number) => void;
  rect: (() => DOMRect | null) | null;
  type: SuggestionMenuType;
  /** Current search query for highlighting matches */
  query?: string;
  /** Ref to a container element — the popup will match its width and left edge */
  containerRef?: React.RefObject<HTMLElement | null>;
}

interface PopupPlacement {
  style: React.CSSProperties;
  /** Whether the popup matches a container (otherwise it has a fixed width). */
  hasContainer: boolean;
}

const HIDDEN_PLACEMENT: PopupPlacement = {
  style: { position: 'fixed', visibility: 'hidden' as const, zIndex: 50 },
  hasContainer: false,
};

function computePlacement(
  rect: (() => DOMRect | null) | null,
  container: HTMLElement | null,
): PopupPlacement {
  const hasContainer = Boolean(container);
  if (!rect) return { ...HIDDEN_PLACEMENT, hasContainer };
  const r = rect();
  if (!r) return { ...HIDDEN_PLACEMENT, hasContainer };
  // If a container ref is provided, match its left edge and width
  const containerRect = container?.getBoundingClientRect();
  return {
    style: {
      position: 'fixed',
      left: containerRect ? containerRect.left : r.left,
      width: containerRect ? containerRect.width : undefined,
      // Align the popup's bottom edge to the top of the container (or cursor)
      bottom: window.innerHeight - (containerRect ? containerRect.top : r.top) + 4,
      zIndex: 50,
    },
    hasContainer,
  };
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

type TranslatedLabel = { key: string; fallback: string };

const EMPTY_LABELS: Record<SuggestionMenuType, TranslatedLabel> = {
  file: { key: 'prompt.noFilesMatch', fallback: 'No files match' },
  symbol: { key: 'prompt.noSymbolsMatch', fallback: 'No symbols match' },
  workflow: { key: 'prompt.noWorkflowsMatch', fallback: 'No workflows match' },
  slash: { key: 'skills.noSkillsFound', fallback: 'No skills found' },
};

const ITEM_TEST_ID_PREFIX: Record<SuggestionMenuType, string> = {
  symbol: 'symbol-item',
  file: 'mention-item',
  workflow: 'workflow-item',
  slash: 'slash-item',
};

const ITEM_LABEL: Record<SuggestionMenuType, (label: string) => string> = {
  slash: (label) => `/${label}`,
  workflow: (label) => `>> ${label}`,
  symbol: (label) => label,
  file: (label) => middleTruncate(label),
};

const SMALL_ICON_CLASS = 'icon-sm text-muted-foreground mt-0.5 shrink-0';
const BASE_ICON_CLASS = 'icon-base text-muted-foreground mt-0.5 shrink-0';

/** Icon of one row: by menu for symbols and files, by item for commands. */
function SuggestionIcon({ type, item }: { type: SuggestionMenuType; item: SuggestionItem }) {
  if (type === 'symbol')
    return <SymbolKindIcon kind={item.symbolKind} className={SMALL_ICON_CLASS} />;
  if (type === 'file') {
    return item.fileType === 'folder' ? (
      <FolderOpen className={SMALL_ICON_CLASS} />
    ) : (
      <FileText className={SMALL_ICON_CLASS} />
    );
  }
  if (item.type === 'workflow') return <WorkflowIcon className={BASE_ICON_CLASS} />;
  if (item.type === 'skill') return <Sparkles className={BASE_ICON_CLASS} />;
  return <Zap className={BASE_ICON_CLASS} />;
}

interface SuggestionRowProps {
  item: SuggestionItem;
  index: number;
  selected: boolean;
  type: SuggestionMenuType;
  query: string;
  onSelect: (item: SuggestionItem) => void;
  onHover: (index: number) => void;
}

function SuggestionRow({
  item,
  index,
  selected,
  type,
  query,
  onSelect,
  onHover,
}: SuggestionRowProps) {
  return (
    <button
      type="button"
      data-testid={`${ITEM_TEST_ID_PREFIX[type]}-${item.id}`}
      className={cn(
        'flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent',
        selected && 'bg-accent',
      )}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect(item);
      }}
      onMouseEnter={() => onHover(index)}
    >
      <SuggestionIcon type={type} item={item} />
      <div className="min-w-0">
        <HighlightText
          text={ITEM_LABEL[type](item.label)}
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
  );
}

/**
 * Computes the position before paint to avoid flash/jump. It is recalculated
 * whenever the caret rect changes; the container is read here, not during
 * render, since it is a ref.
 */
function usePopupPlacement(
  rect: SuggestionPopupProps['rect'],
  containerRef: SuggestionPopupProps['containerRef'],
) {
  const [placement, setPlacement] = useState(HIDDEN_PLACEMENT);
  useLayoutEffect(() => {
    setPlacement(computePlacement(rect, containerRef?.current ?? null));
  }, [rect, containerRef]);
  return placement;
}

/**
 * Scroll selected into view — use scrollTop manipulation instead of
 * scrollIntoView which can scroll parent containers and cause jumps.
 */
function useScrollSelectedIntoView(
  popupRef: React.RefObject<HTMLDivElement | null>,
  selectedIndex: number,
) {
  useEffect(() => {
    const container = popupRef.current;
    if (!container) return;
    const el = container.children[selectedIndex];
    if (!(el instanceof HTMLElement)) return;
    const elTop = el.offsetTop;
    const elBottom = elTop + el.offsetHeight;
    if (elTop < container.scrollTop) {
      container.scrollTop = elTop;
    } else if (elBottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = elBottom - container.clientHeight;
    }
  }, [popupRef, selectedIndex]);
}

/** The popup's frame, portaled to the body at the computed placement. */
function PopupShell({
  placement,
  popupRef,
  children,
}: {
  placement: PopupPlacement;
  popupRef?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}) {
  return createPortal(
    <div
      ref={popupRef}
      data-suggestion-popup
      style={placement.style}
      className={cn(
        'max-h-52 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md',
        !placement.hasContainer && 'w-80',
      )}
    >
      {children}
    </div>,
    document.body,
  );
}

export function SuggestionPopup({
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
  const placement = usePopupPlacement(rect, containerRef);
  useScrollSelectedIntoView(popupRef, selectedIndex);

  if (loading && items.length === 0) {
    const loadingLabel = getSuggestionLoadingLabel(type);
    return (
      <PopupShell placement={placement}>
        <div className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-xs">
          <Loader2 className="icon-xs animate-spin" />
          {t(loadingLabel.key, loadingLabel.fallback)}
        </div>
      </PopupShell>
    );
  }

  if (items.length === 0) {
    const emptyLabel = EMPTY_LABELS[type];
    return (
      <PopupShell placement={placement}>
        <div className="text-muted-foreground px-3 py-2 text-xs">
          {t(emptyLabel.key, emptyLabel.fallback)}
        </div>
      </PopupShell>
    );
  }

  return (
    <PopupShell placement={placement} popupRef={popupRef}>
      {items.map((item, i) => (
        <SuggestionRow
          key={`${item.type}:${item.id}`}
          item={item}
          index={i}
          selected={i === selectedIndex}
          type={type}
          query={query}
          onSelect={onSelect}
          onHover={onHover}
        />
      ))}
      {truncated && (
        <div className="border-border text-muted-foreground border-t px-3 py-1.5 text-xs">
          {t('prompt.moreFilesHint', 'Type to narrow results…')}
        </div>
      )}
    </PopupShell>
  );
}
