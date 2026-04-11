import type { AgentModel, PermissionMode } from '@funny/shared';
import { FileText, FolderOpen, ChevronRight, ChevronDown, Slash } from 'lucide-react';
import { useState, useRef, useLayoutEffect, useCallback, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import type { ReferencedItem } from '@/lib/parse-referenced-files';
import { parseReferencedFiles } from '@/lib/parse-referenced-files';
import { resolveModelLabel, timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

const COLLAPSED_MAX_H = 48; // px – roughly 8 lines of text

export interface UserMessageCardProps {
  /** The raw message content (may include <referenced-files> XML) */
  content: string;
  /** Optional image attachments */
  images?: { source: { media_type: string; data: string } }[];
  /** Model used for this message */
  model?: AgentModel;
  /** Permission mode active when the message was sent */
  permissionMode?: PermissionMode;
  /** ISO timestamp */
  timestamp?: string;
  /** Click handler (e.g. scroll to section) */
  onClick?: () => void;
  /** Open lightbox for an image */
  onImageClick?: (images: { src: string; alt: string }[], index: number) => void;
  /** data-testid */
  'data-testid'?: string;
}

/** Renders a file/folder reference chip inline */
function FileChip({ item }: { item: ReferencedItem }) {
  return (
    <span
      className="mx-0.5 inline-flex items-center gap-1 rounded bg-background/20 px-1.5 py-0.5 align-middle font-mono text-xs text-background/70"
      title={item.path}
    >
      {item.type === 'folder' ? (
        <FolderOpen className="icon-xs shrink-0" />
      ) : (
        <FileText className="icon-xs shrink-0" />
      )}
      {item.path.split('/').pop()}
    </span>
  );
}

/** Renders a slash command chip inline */
function SlashCommandChip({ name }: { name: string }) {
  return (
    <span
      data-testid="user-message-slash-command"
      className="mr-1 inline-flex items-center gap-0.5 rounded bg-background/20 px-1.5 py-0.5 align-middle font-mono text-xs font-medium text-background/70"
    >
      <Slash className="icon-xs shrink-0" />
      {name}
    </span>
  );
}

/**
 * Splits text on @path mentions and /slash-command prefixes, replacing them
 * with inline FileChip / SlashCommandChip components.
 * Returns an array of ReactNode (strings and chip elements).
 */
function renderInlineContent(text: string, fileMap: Map<string, ReferencedItem>): ReactNode[] {
  // Build combined regex: slash commands (at start) + @path mentions
  const regexParts: string[] = [];

  // Slash command: /name at the very beginning of the text
  // Match /word characters, colons, dots, hyphens (e.g. /skill-creator:skill-creator)
  regexParts.push('^\\/([\\w:.-]+)');

  // @path mentions
  if (fileMap.size > 0) {
    const escapedPaths = Array.from(fileMap.keys())
      .sort((a, b) => b.length - a.length)
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    regexParts.push(`@(${escapedPaths.join('|')})`);
  }

  if (regexParts.length === 0) return [text];

  const pattern = new RegExp(regexParts.join('|'), 'g');
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[1] !== undefined) {
      // Slash command match (group 1)
      parts.push(<SlashCommandChip key={`slash-${match.index}`} name={match[1]} />);
    } else if (match[2] !== undefined) {
      // @path mention match (group 2)
      const item = fileMap.get(match[2]);
      if (item) {
        parts.push(<FileChip key={`chip-${match.index}`} item={item} />);
      }
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

function UserMessageContent({
  content,
  fileMap,
}: {
  content: string;
  fileMap: Map<string, ReferencedItem>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [isScrolledToBottom, setIsScrolledToBottom] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const inlineNodes = useMemo(() => renderInlineContent(content, fileMap), [content, fileMap]);

  const checkScrollEnd = useCallback(() => {
    const el = preRef.current;
    if (!el) return;
    const threshold = 4;
    setIsScrolledToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < threshold);
  }, []);

  useLayoutEffect(() => {
    const el = preRef.current;
    if (el) {
      setIsOverflowing(el.scrollHeight > COLLAPSED_MAX_H);
    }
  }, [content]);

  useLayoutEffect(() => {
    if (expanded) checkScrollEnd();
  }, [expanded, checkScrollEnd]);

  return (
    <div ref={containerRef} className="relative">
      <pre
        ref={preRef}
        onScroll={expanded ? checkScrollEnd : undefined}
        className={cn(
          'whitespace-pre-wrap font-sans text-sm leading-relaxed break-words overflow-x-auto',
          !expanded && isOverflowing && 'overflow-hidden',
          expanded && 'max-h-[40vh] overflow-y-auto',
        )}
        style={!expanded && isOverflowing ? { maxHeight: COLLAPSED_MAX_H } : undefined}
      >
        {inlineNodes}
      </pre>
      {isOverflowing && !expanded && (
        <div className="pointer-events-none absolute bottom-6 left-0 right-0 h-10 bg-gradient-to-t from-foreground to-transparent" />
      )}
      {expanded && !isScrolledToBottom && (
        <div className="pointer-events-none absolute bottom-6 left-0 right-0 h-10 bg-gradient-to-t from-foreground to-transparent" />
      )}
      {isOverflowing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (expanded) {
              // Reset scroll inside the pre element
              preRef.current?.scrollTo(0, 0);
              // Scroll the card into view so it's visible after collapsing
              containerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
            setExpanded(!expanded);
          }}
          className="mt-1 flex items-center gap-1 text-[11px] font-medium text-background transition-colors hover:text-background/80"
        >
          {expanded ? (
            <>
              <ChevronRight className="icon-xs -rotate-90" />
              {t('thread.showLess', 'Show less')}
            </>
          ) : (
            <>
              <ChevronDown className="icon-xs" />
              {t('thread.showMore', 'Show more')}
            </>
          )}
        </button>
      )}
    </div>
  );
}

export function UserMessageCard({
  content,
  images,
  model,
  permissionMode,
  timestamp,
  onClick,
  onImageClick,
  ...props
}: UserMessageCardProps) {
  const { t } = useTranslation();
  const { inlineContent, fileMap } = parseReferencedFiles(content);

  const allImages = images?.map((i, j) => ({
    src: `data:${i.source.media_type};base64,${i.source.data}`,
    alt: `Attachment ${j + 1}`,
  }));

  return (
    <div
      data-testid={props['data-testid']}
      className={cn(
        'relative group text-sm',
        'w-full rounded-lg px-3 py-2 bg-foreground text-background',
        onClick && 'cursor-pointer',
        'shadow-md',
      )}
      onClick={onClick}
    >
      {/* Image attachments */}
      {allImages && allImages.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {allImages.map((img, idx) => (
            <img
              key={`attachment-${idx}`}
              src={img.src}
              alt={img.alt}
              loading="lazy"
              className="max-h-10 min-h-10 min-w-10 max-w-24 cursor-pointer rounded border border-border object-cover transition-opacity hover:opacity-80"
              onClick={(e) => {
                e.stopPropagation();
                onImageClick?.(allImages, idx);
              }}
            />
          ))}
        </div>
      )}

      {/* Message content with inline file chips */}
      <UserMessageContent content={inlineContent.trim()} fileMap={fileMap} />

      {/* Metadata: model + permission mode + timestamp */}
      <div className="mt-1.5 flex items-center justify-between">
        <div className="flex gap-1">
          {model && (
            <Badge
              variant="outline"
              className="h-4 border-background/20 bg-background/10 px-1.5 py-0 text-[10px] font-medium text-background/60"
            >
              {resolveModelLabel(model, t)}
            </Badge>
          )}
          {permissionMode && (
            <Badge
              variant="outline"
              className="h-4 border-background/20 bg-background/10 px-1.5 py-0 text-[10px] font-medium text-background/60"
            >
              {t(`prompt.${permissionMode}`)}
            </Badge>
          )}
        </div>
        {timestamp && (
          <span className="text-[10px] text-background/50">{timeAgo(timestamp, t)}</span>
        )}
      </div>
    </div>
  );
}
