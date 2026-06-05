import { Paperclip } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { HighlightText } from '@/components/ui/highlight-text';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ReferencedItem } from '@/lib/parse-referenced-files';
import { cleanThreadTitle } from '@/lib/thread-title';
import { cn } from '@/lib/utils';

interface ThreadAttachmentsBadgeProps {
  files: ReferencedItem[];
  className?: string;
  'data-testid'?: string;
  /** Stop propagation on click so it doesn't bubble to a parent click handler */
  stopPropagation?: boolean;
}

/**
 * Compact paperclip + count indicator with a tooltip listing the attached
 * files. Used in thread list/card displays where the prompt was stored with
 * a `<referenced-files>` XML block.
 */
export function ThreadAttachmentsBadge({
  files,
  className,
  stopPropagation,
  ...props
}: ThreadAttachmentsBadgeProps) {
  const { t } = useTranslation();
  if (files.length === 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid={props['data-testid']}
          onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
          className={cn(
            'inline-flex shrink-0 items-center gap-0.5 text-muted-foreground',
            className,
          )}
        >
          <Paperclip className="icon-xs" />
          <span className="text-[10px] leading-none">{files.length}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        <div className="font-medium">
          {t('thread.attachments', {
            defaultValue: '{{count}} attached files',
            count: files.length,
          })}
        </div>
        <ul className="mt-1 space-y-0.5">
          {files.map((f) => (
            <li key={f.path} className="truncate font-mono">
              {f.path}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

interface ThreadTitleProps {
  /** Raw thread title (may include a `<referenced-files>` XML block) */
  title: string;
  /** Search query to highlight inside the cleaned title */
  search?: string;
  /** Classes for the title text element */
  className?: string;
  /** Classes for the wrapping flex row */
  containerClassName?: string;
  /** Multi-line title (e.g. kanban cards). Aligns badge to the start. */
  multiline?: boolean;
  /** `data-testid` for the attachment badge */
  badgeTestId?: string;
  /** Stop click propagation on the badge */
  stopBadgePropagation?: boolean;
}

/**
 * Renders a thread title with the `<referenced-files>` XML stripped out and a
 * compact 📎 badge listing the attached files. Centralizes the pattern that
 * was previously duplicated across every list/card surface.
 */
export function ThreadTitle({
  title,
  search,
  className,
  containerClassName,
  multiline,
  badgeTestId,
  stopBadgePropagation,
}: ThreadTitleProps) {
  const { displayTitle, attachedFiles } = useMemo(() => cleanThreadTitle(title), [title]);
  const titleClass = cn(multiline ? 'flex-1' : 'min-w-0 flex-1 truncate', className);

  return (
    <div
      className={cn(
        'flex min-w-0 gap-1.5',
        multiline ? 'items-start' : 'items-center',
        containerClassName,
      )}
    >
      {search !== undefined ? (
        <HighlightText text={displayTitle} query={search} className={titleClass} />
      ) : (
        <span className={titleClass}>{displayTitle}</span>
      )}
      <ThreadAttachmentsBadge
        files={attachedFiles}
        className={multiline ? 'mt-0.5' : undefined}
        stopPropagation={stopBadgePropagation}
        data-testid={badgeTestId}
      />
    </div>
  );
}
