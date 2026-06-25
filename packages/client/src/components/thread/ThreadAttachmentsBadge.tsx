import { Paperclip } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { LinearIssueBadge } from '@/components/LinearIssueBadge';
import { CommandLineChip, SkillChip, type ChipSize } from '@/components/ui/chip';
import { HighlightText } from '@/components/ui/highlight-text';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ReferencedItem } from '@/lib/parse-referenced-files';
import { parseThreadTitleForDisplay } from '@/lib/thread-title';
import { cn } from '@/lib/utils';

const URL_LIKE_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+/i;
type ThreadTitleDensity = 'default' | 'compact' | 'title';

const TOKEN_DENSITY: Record<ThreadTitleDensity, { chipSize: ChipSize; linearSize: 'xs' | 'xxs' }> =
  {
    default: { chipSize: 'xs', linearSize: 'xxs' },
    compact: { chipSize: 'xxs', linearSize: 'xxs' },
    title: { chipSize: 'sm', linearSize: 'xs' },
  };

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
  /** Root element. Use `span` when rendering inside text-only parents like h1/p. */
  as?: 'div' | 'span';
  /** Search query to highlight inside the cleaned title */
  search?: string;
  /** Classes for the title text element */
  className?: string;
  /** Classes for the wrapping flex row */
  containerClassName?: string;
  /** Multi-line title (e.g. kanban cards). Aligns badge to the start. */
  multiline?: boolean;
  /** Controls the size of parsed command / issue chips. */
  density?: ThreadTitleDensity;
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
  as: Root = 'div',
  search,
  className,
  containerClassName,
  multiline,
  density = 'default',
  badgeTestId,
  stopBadgePropagation,
}: ThreadTitleProps) {
  const { attachedFiles, leadingCommand, linearIssue, visibleText } = useMemo(
    () => parseThreadTitleForDisplay(title),
    [title],
  );
  const tokenSize = TOKEN_DENSITY[density];
  const titleClass = cn(
    !URL_LIKE_RE.test(visibleText.trimStart()) && 'first-letter:uppercase',
    multiline ? 'flex-1' : 'min-w-0 flex-1 truncate',
    className,
  );
  // Render leading `/slash-command` and `!command` titles as chips matching the
  // main thread message, then treat any remainder as plain title text.

  return (
    <Root
      className={cn(
        'flex min-w-0 gap-1.5',
        multiline ? 'items-start' : 'items-center',
        containerClassName,
      )}
    >
      {leadingCommand.kind === 'slash' && leadingCommand.command && (
        <SkillChip
          name={leadingCommand.command}
          size={tokenSize.chipSize}
          className="mx-0 shrink-0"
          data-testid="thread-title-slash-command"
        />
      )}
      {leadingCommand.kind === 'shell' && leadingCommand.command && (
        <CommandLineChip
          command={leadingCommand.command}
          size={tokenSize.chipSize}
          className="mx-0 min-w-0"
          data-testid="thread-title-command-line"
        />
      )}
      {leadingCommand.kind !== 'shell' &&
        visibleText &&
        (search !== undefined ? (
          <HighlightText text={visibleText} query={search} className={titleClass} />
        ) : (
          <span className={titleClass}>{visibleText}</span>
        ))}
      {leadingCommand.kind !== 'shell' && linearIssue && (
        <LinearIssueBadge
          issueKey={linearIssue.issueKey}
          issueUrl={linearIssue.url}
          size={tokenSize.linearSize}
          data-testid="thread-title-linear-issue"
        />
      )}
      <ThreadAttachmentsBadge
        files={attachedFiles}
        className={multiline ? 'mt-0.5' : undefined}
        stopPropagation={stopBadgePropagation}
        data-testid={badgeTestId}
      />
    </Root>
  );
}
