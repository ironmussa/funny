import { Paperclip } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { LinearIssueBadge } from '@/components/LinearIssueBadge';
import { PRBadge } from '@/components/PRBadge';
import { CommandLineChip, SkillChip, type ChipSize } from '@/components/ui/chip';
import { HighlightText } from '@/components/ui/highlight-text';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ReferencedItem } from '@/lib/parse-referenced-files';
import { parseThreadTitleForDisplay, type ThreadTitlePart } from '@/lib/thread-title';
import { cn } from '@/lib/utils';

const URL_LIKE_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+/i;
type ThreadTitleDensity = 'default' | 'compact' | 'title';

const TOKEN_DENSITY: Record<
  ThreadTitleDensity,
  { chipSize: ChipSize; referenceSize: 'xs' | 'xxs' }
> = {
  default: { chipSize: 'xs', referenceSize: 'xxs' },
  compact: { chipSize: 'xxs', referenceSize: 'xxs' },
  title: { chipSize: 'sm', referenceSize: 'xs' },
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

function ThreadTitlePartRenderer({
  part,
  partIndex,
  search,
  titleClass,
  capitalizeFirstLetter,
  tokenSize,
}: {
  part: ThreadTitlePart;
  partIndex: number;
  search?: string;
  titleClass: string;
  capitalizeFirstLetter: boolean;
  tokenSize: (typeof TOKEN_DENSITY)[ThreadTitleDensity];
}) {
  if (part.kind === 'linearIssue') {
    return (
      <LinearIssueBadge
        issueKey={part.reference.issueKey}
        issueUrl={part.reference.url}
        size={tokenSize.referenceSize}
        data-testid="thread-title-linear-issue"
      />
    );
  }

  if (part.kind === 'githubPullRequest') {
    return (
      <PRBadge
        prNumber={part.reference.prNumber}
        prUrl={part.reference.url}
        size={tokenSize.referenceSize}
        data-testid="thread-title-github-pr"
      />
    );
  }

  return search !== undefined ? (
    <HighlightText
      key={`text-${partIndex}`}
      text={part.text}
      query={search}
      className={cn(titleClass, capitalizeFirstLetter && 'first-letter:uppercase')}
    />
  ) : (
    <span
      key={`text-${partIndex}`}
      className={cn(titleClass, capitalizeFirstLetter && 'first-letter:uppercase')}
    >
      {part.text}
    </span>
  );
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
  const { attachedFiles, leadingCommand, titleParts, visibleText } = useMemo(
    () => parseThreadTitleForDisplay(title),
    [title],
  );
  const tokenSize = TOKEN_DENSITY[density];
  const shouldCapitalizeTitle = !URL_LIKE_RE.test(visibleText.trimStart());
  const titleClass = cn('min-w-0', !multiline && 'truncate', className);
  const hasReferenceParts = titleParts.some((part) => part.kind !== 'text');
  const firstTextPartIndex = titleParts.findIndex((part) => part.kind === 'text');
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
        (hasReferenceParts ? (
          <span
            className={cn(
              'flex min-w-0 flex-1 gap-1.5',
              multiline ? 'flex-wrap items-start' : 'items-center overflow-hidden',
            )}
          >
            {titleParts.map((part, index) => (
              <ThreadTitlePartRenderer
                key={part.id}
                part={part}
                partIndex={index}
                search={search}
                titleClass={titleClass}
                capitalizeFirstLetter={shouldCapitalizeTitle && index === firstTextPartIndex}
                tokenSize={tokenSize}
              />
            ))}
          </span>
        ) : visibleText && search !== undefined ? (
          <HighlightText
            text={visibleText}
            query={search}
            className={cn(titleClass, shouldCapitalizeTitle && 'first-letter:uppercase', 'flex-1')}
          />
        ) : (
          visibleText && (
            <span
              className={cn(
                titleClass,
                shouldCapitalizeTitle && 'first-letter:uppercase',
                'flex-1',
              )}
            >
              {visibleText}
            </span>
          )
        ))}
      <ThreadAttachmentsBadge
        files={attachedFiles}
        className={multiline ? 'mt-0.5' : undefined}
        stopPropagation={stopBadgePropagation}
        data-testid={badgeTestId}
      />
    </Root>
  );
}
