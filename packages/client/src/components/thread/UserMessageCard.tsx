import type { AgentModel, PermissionMode } from '@funny/shared';
import { FileText, FolderOpen, ChevronRight, ChevronDown } from 'lucide-react';
import { useState, useRef, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
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

function UserMessageContent({ content }: { content: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    const el = preRef.current;
    if (el) {
      setIsOverflowing(el.scrollHeight > COLLAPSED_MAX_H);
    }
  }, [content]);

  return (
    <div className="relative">
      <pre
        ref={preRef}
        className={cn(
          'whitespace-pre-wrap font-mono text-xs leading-relaxed break-words overflow-x-auto',
          !expanded && isOverflowing && 'overflow-hidden',
          expanded && 'max-h-[40vh] overflow-y-auto',
        )}
        style={!expanded && isOverflowing ? { maxHeight: COLLAPSED_MAX_H } : undefined}
      >
        {content}
      </pre>
      {isOverflowing && !expanded && (
        <div className="pointer-events-none absolute bottom-6 left-0 right-0 h-10 bg-gradient-to-t from-foreground to-transparent" />
      )}
      {isOverflowing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          className="mt-1 flex items-center gap-1 text-[11px] font-medium text-background transition-colors hover:text-background/80"
        >
          {expanded ? (
            <>
              <ChevronRight className="h-3 w-3 -rotate-90" />
              {t('thread.showLess', 'Show less')}
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
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
  const { files, cleanContent } = parseReferencedFiles(content);

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
              width={80}
              height={80}
              loading="lazy"
              className="max-h-20 cursor-pointer rounded border border-border transition-opacity hover:opacity-80"
              onClick={(e) => {
                e.stopPropagation();
                onImageClick?.(allImages, idx);
              }}
            />
          ))}
        </div>
      )}

      {/* Referenced files badges */}
      {files.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {files.map((fileItem) => (
            <span
              key={`${fileItem.type}:${fileItem.path}`}
              className="inline-flex items-center gap-1 rounded bg-background/20 px-1.5 py-0.5 font-mono text-xs text-background/70"
              title={fileItem.path}
            >
              {fileItem.type === 'folder' ? (
                <FolderOpen className="h-3 w-3 shrink-0" />
              ) : (
                <FileText className="h-3 w-3 shrink-0" />
              )}
              {fileItem.path.split('/').pop()}
            </span>
          ))}
        </div>
      )}

      {/* Message content */}
      <UserMessageContent content={cleanContent.trim()} />

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
