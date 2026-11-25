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
import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { HighlightText } from '@/components/ui/highlight-text';
import { middleTruncate } from '@/lib/text-truncate';
import { cn } from '@/lib/utils';

import { getSuggestionLoadingLabel } from './suggestion-items';
import type { SuggestionItem, SuggestionMenuType } from './types';

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

interface SuggestionPopupPosition {
  left: number;
  bottom: number;
  width?: number;
}

/**
 * The fixed, portalled box of the suggestion popup. `position` null keeps it
 * hidden until there is a rect to anchor it to; a measured width wins over the
 * `w-80` fallback, as the inline width did.
 */
function SuggestionPopupFrame({
  position,
  fallbackWidth,
  ref,
  children,
}: {
  position: SuggestionPopupPosition | null;
  fallbackWidth: boolean;
  ref?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}) {
  const width = position?.width;
  return createPortal(
    <div
      ref={ref}
      data-suggestion-popup
      style={{
        '--suggestion-popup-left': position ? `${position.left}px` : undefined,
        '--suggestion-popup-bottom': position ? `${position.bottom}px` : undefined,
        '--suggestion-popup-width': width === undefined ? undefined : `${width}px`,
      }}
      className={cn(
        'fixed z-50 max-h-52 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md',
        position
          ? 'bottom-[var(--suggestion-popup-bottom)] left-[var(--suggestion-popup-left)]'
          : 'invisible',
        fallbackWidth && 'w-80',
        width !== undefined && 'w-[var(--suggestion-popup-width)]',
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

  // Compute position synchronously to avoid flash/jump.
  // We recalculate on every render that changes rect or items.
  // `null` keeps the popup hidden until there is a rect to anchor it to.
  const position = useMemo<SuggestionPopupPosition | null>(() => {
    if (!rect) return null;
    const r = rect();
    if (!r) return null;
    // If a container ref is provided, match its left edge and width
    const container = containerRef?.current;
    const containerRect = container?.getBoundingClientRect();
    return {
      left: containerRect ? containerRect.left : r.left,
      width: containerRect ? containerRect.width : undefined,
      // Align the popup's bottom edge to the top of the container (or cursor)
      bottom: window.innerHeight - (containerRect ? containerRect.top : r.top) + 4,
    };
  }, [rect, containerRef]);
  // No container to match: the popup takes the fixed w-80 width.
  const fallbackWidth = !containerRef?.current;

  // Scroll selected into view — use scrollTop manipulation instead of
  // scrollIntoView which can scroll parent containers and cause jumps.
  useEffect(() => {
    const container = popupRef.current;
    if (!container) return;
    const el = container.children.item(selectedIndex);
    if (!(el instanceof HTMLElement)) return;
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
    return (
      <SuggestionPopupFrame position={position} fallbackWidth={fallbackWidth}>
        <div className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-xs">
          <Loader2 className="icon-xs animate-spin" />
          {t(loadingLabel.key, loadingLabel.fallback)}
        </div>
      </SuggestionPopupFrame>
    );
  }

  if (items.length === 0) {
    return (
      <SuggestionPopupFrame position={position} fallbackWidth={fallbackWidth}>
        <div className="text-muted-foreground px-3 py-2 text-xs">
          {
            // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
            type === 'file'
              ? t('prompt.noFilesMatch', 'No files match')
              : type === 'symbol'
                ? t('prompt.noSymbolsMatch', 'No symbols match')
                : type === 'workflow'
                  ? t('prompt.noWorkflowsMatch', 'No workflows match')
                  : t('skills.noSkillsFound', 'No skills found')
          }
        </div>
      </SuggestionPopupFrame>
    );
  }

  return (
    <SuggestionPopupFrame ref={popupRef} position={position} fallbackWidth={fallbackWidth}>
      {items.map((item, i) => (
        <button
          type="button"
          key={`${item.type}:${item.id}`}
          data-testid={
            // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
            type === 'symbol'
              ? `symbol-item-${item.id}`
              : type === 'file'
                ? `mention-item-${item.id}`
                : type === 'workflow'
                  ? `workflow-item-${item.id}`
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
          ) : item.type === 'workflow' ? (
            <WorkflowIcon className="icon-base text-muted-foreground mt-0.5 shrink-0" />
          ) : item.type === 'skill' ? (
            <Sparkles className="icon-base text-muted-foreground mt-0.5 shrink-0" />
          ) : (
            <Zap className="icon-base text-muted-foreground mt-0.5 shrink-0" />
          )}
          <div className="min-w-0">
            <HighlightText
              text={
                // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
                type === 'slash'
                  ? `/${item.label}`
                  : type === 'workflow'
                    ? `>> ${item.label}`
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
    </SuggestionPopupFrame>
  );
}
