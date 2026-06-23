import type { AgentModel, EffortLevel, PermissionMode } from '@funny/shared';
import { ChevronRight, ChevronDown, GitBranch, Undo2, RotateCcw, MoreVertical } from 'lucide-react';
import {
  useState,
  useRef,
  useLayoutEffect,
  useCallback,
  useMemo,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { CommandLineChip, FileChip, SkillChip } from '@/components/ui/chip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ReferencedItem } from '@/lib/parse-referenced-files';
import { parseReferencedFiles } from '@/lib/parse-referenced-files';
import { EFFORT_LEVELS } from '@/lib/providers';
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
  /** Reasoning/effort level active when the message was sent */
  effort?: EffortLevel;
  /** ISO timestamp */
  timestamp?: string;
  /** Click handler (e.g. scroll to section) */
  onClick?: () => void;
  /** Open lightbox for an image */
  onImageClick?: (images: { src: string; alt: string }[], index: number) => void;
  /** Fork the thread starting from this message */
  onFork?: () => void;
  /** Rewind code (and conversation) back to this message in place */
  onRewind?: () => void;
  /** Fork the conversation AND rewind code on the new fork */
  onForkAndRewind?: () => void;
  /** Disable the fork button (e.g. while a fork is in flight) */
  forkDisabled?: boolean;
  /**
   * Disable the rewind options (e.g. when the thread was started without
   * file checkpointing or the provider isn't Claude). When true, the rewind
   * items render grayed-out with a tooltip explaining why.
   */
  rewindDisabled?: boolean;
  /** Reason shown in the disabled-rewind tooltip. */
  rewindDisabledReason?: string;
  /** data-testid */
  'data-testid'?: string;
}

/** Renders a file/folder reference chip inline (inverse variant for dark card). */
function ReferencedFileChip({ item }: { item: ReferencedItem }) {
  return (
    <FileChip
      name={item.path.split('/').pop() ?? item.path}
      type={item.type}
      title={item.path}
      variant="inverse"
    />
  );
}

/** Renders a slash command / skill chip inline (inverse variant for dark card). */
function UserMessageSkillChip({ name }: { name: string }) {
  return <SkillChip name={name} variant="inverse" data-testid="user-message-slash-command" />;
}

/** Renders a command-line chip for `!` commands (inverse variant for dark card). */
function UserMessageCommandLineChip({ command }: { command: string }) {
  return (
    <CommandLineChip command={command} variant="inverse" data-testid="user-message-command-line" />
  );
}

/**
 * Splits text on @path mentions, /slash-command prefixes, and leading
 * !command lines, replacing them with inline chips.
 * Returns an array of ReactNode (strings and chip elements).
 */
function renderInlineContent(text: string, fileMap: Map<string, ReferencedItem>): ReactNode[] {
  // Build combined regex: leading command lines + slash commands + @path mentions
  const regexParts: string[] = [];

  // Command line: !cmd at the start of the message or line. The command consumes
  // that line, because this prefix is used to send shell commands.
  regexParts.push('(?<=^|\\n)!\\s*([^\\n]+)');

  // Slash command: /name at start of text or after whitespace, not adjacent to
  // any path-continuation char (so /home/user/... isn't mistaken for a command,
  // and the regex can't backtrack to /hom + "e/..." either).
  // Match /word characters, colons, dots, hyphens (e.g. /skill-creator:skill-creator)
  regexParts.push('(?<=^|\\s)\\/([\\w:.-]+)(?![\\w/:.-])');

  // @path mentions — always present as group 3, even if empty (use a never-matching
  // pattern so URL stays as group 4 regardless of fileMap size).
  if (fileMap.size > 0) {
    const escapedPaths = Array.from(fileMap.keys())
      .sort((a, b) => b.length - a.length)
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    regexParts.push(`@(${escapedPaths.join('|')})`);
  } else {
    regexParts.push('()(?!)');
  }

  // URLs (http/https) — trailing punctuation is stripped after match.
  regexParts.push('(https?:\\/\\/[^\\s<]+)');

  const pattern = new RegExp(regexParts.join('|'), 'g');
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[1] !== undefined) {
      // Command-line match (group 1)
      parts.push(
        <UserMessageCommandLineChip
          key={`command-line-${match.index}`}
          command={match[1].trim()}
        />,
      );
      lastIndex = match.index + match[0].length;
    } else if (match[2] !== undefined) {
      // Slash command match (group 2)
      parts.push(<UserMessageSkillChip key={`slash-${match.index}`} name={match[2]} />);
      lastIndex = match.index + match[0].length;
    } else if (match[3] !== undefined) {
      // @path mention match (group 3)
      const item = fileMap.get(match[3]);
      if (item) {
        parts.push(<ReferencedFileChip key={`chip-${match.index}`} item={item} />);
      }
      lastIndex = match.index + match[0].length;
    } else if (match[4] !== undefined) {
      // URL match (group 4) — strip trailing punctuation so ")", ".", "," etc. stay as text
      let url = match[4];
      let trailing = '';
      const trailingMatch = url.match(/[)\]}.,;:!?'"]+$/);
      if (trailingMatch) {
        trailing = trailingMatch[0];
        url = url.slice(0, -trailing.length);
      }
      parts.push(
        <a
          key={`url-${match.index}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-background/70 decoration-background/45 hover:text-background hover:decoration-background/75 underline underline-offset-2"
          onClick={(e) => e.stopPropagation()}
        >
          {url}
        </a>,
      );
      if (trailing) parts.push(trailing);
      lastIndex = match.index + match[0].length;
    } else {
      lastIndex = match.index + match[0].length;
    }
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
          'whitespace-pre-wrap font-sans text-sm leading-relaxed wrap-break-word overflow-x-auto',
          !expanded && isOverflowing && 'overflow-hidden',
          expanded && 'max-h-[40vh] overflow-y-auto',
        )}
        style={
          !expanded && isOverflowing
            ? {
                maxHeight: COLLAPSED_MAX_H,
                WebkitMaskImage: 'linear-gradient(to bottom, black 55%, transparent)',
                maskImage: 'linear-gradient(to bottom, black 55%, transparent)',
              }
            : undefined
        }
      >
        {inlineNodes}
      </pre>
      {expanded && !isScrolledToBottom && (
        <div className="from-foreground pointer-events-none absolute right-0 bottom-6 left-0 h-10 bg-linear-to-t to-transparent" />
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
          className="text-background hover:text-background/80 mt-1 flex items-center gap-1 text-[11px] font-medium transition-colors"
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

// eslint-disable-next-line max-lines-per-function
export function UserMessageCard({
  content,
  images,
  model,
  permissionMode,
  effort,
  timestamp,
  onClick,
  onImageClick,
  onFork,
  onRewind,
  onForkAndRewind,
  forkDisabled,
  rewindDisabled,
  rewindDisabledReason,
  ...props
}: UserMessageCardProps) {
  const { t } = useTranslation();
  const { files, inlineContent, fileMap } = parseReferencedFiles(content);

  const allImages = images?.map((i, j) => ({
    src: `data:${i.source.media_type};base64,${i.source.data}`,
    alt: `Attachment ${j + 1}`,
  }));

  // Files attached via the paperclip don't necessarily appear as @path mentions
  // in the prompt text. Surface any referenced file that isn't already rendered
  // inline so the user can see what was sent.
  const unmentionedFiles = files.filter((f) => !inlineContent.includes(`@${f.path}`));
  const hasThreadActions = Boolean(onFork || onRewind || onForkAndRewind);
  const hasFooterBadges = Boolean(model || permissionMode);
  const hasSideMeta = Boolean(hasThreadActions || timestamp);
  let sideMetaJustify = 'justify-start';
  if (timestamp) sideMetaJustify = 'justify-end';
  if (timestamp && hasThreadActions) sideMetaJustify = 'justify-between';
  const handleCardKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!onClick || event.defaultPrevented) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;

      event.preventDefault();
      onClick();
    },
    [onClick],
  );
  const interactiveCardProps = onClick
    ? {
        role: 'button' as const,
        tabIndex: 0,
        onClick,
        onKeyDown: handleCardKeyDown,
      }
    : {};

  return (
    <div
      data-testid={props['data-testid']}
      className={cn(
        'relative group text-sm',
        'w-full rounded-lg py-2 bg-foreground text-background',
        'px-3',
        hasSideMeta && 'grid grid-cols-[minmax(0,1fr)_auto] gap-x-2',
        onClick && 'cursor-pointer',
        'shadow-md',
      )}
      {...interactiveCardProps}
    >
      <div className="min-w-0">
        {/* Image attachments */}
        {allImages && allImages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {allImages.map((img, idx) => (
              <button
                key={img.src}
                type="button"
                aria-label={`Open ${img.alt}`}
                className="border-border max-h-10 min-h-10 max-w-24 min-w-10 cursor-pointer overflow-hidden rounded border p-0 transition-opacity hover:opacity-80"
                onClick={(e) => {
                  e.stopPropagation();
                  onImageClick?.(allImages, idx);
                }}
              >
                <img
                  src={img.src}
                  alt={img.alt}
                  loading="lazy"
                  className="block max-h-10 min-h-10 max-w-24 min-w-10 object-cover"
                />
              </button>
            ))}
          </div>
        )}

        {/* Attached files not already @-mentioned inline */}
        {unmentionedFiles.length > 0 && (
          <div data-testid="user-message-attached-files" className="mb-2 flex flex-wrap gap-1.5">
            {unmentionedFiles.map((item) => (
              <ReferencedFileChip key={`attached-${item.path}`} item={item} />
            ))}
          </div>
        )}

        {/* Message content with inline file chips */}
        <UserMessageContent content={inlineContent.trim()} fileMap={fileMap} />

        {/* Metadata: model and permission mode */}
        {hasFooterBadges && (
          <div className="mt-1.5 flex min-w-0 flex-wrap gap-1">
            {model && (
              <Badge
                variant="outline"
                className="border-background/20 bg-background/10 text-background/60 h-4 px-1.5 py-0 text-[10px] font-medium"
              >
                {resolveModelLabel(model, t)}
                {effort && (
                  <>
                    {' · '}
                    {EFFORT_LEVELS.find((e) => e.value === effort)?.label ?? effort}
                  </>
                )}
              </Badge>
            )}
            {permissionMode && (
              <Badge
                variant="outline"
                className="border-background/20 bg-background/10 text-background/60 h-4 px-1.5 py-0 text-[10px] font-medium"
              >
                {t(`prompt.${permissionMode}`)}
              </Badge>
            )}
          </div>
        )}
      </div>

      {hasSideMeta && (
        <div
          data-testid="user-message-side-meta"
          className={cn('flex min-w-6 flex-col items-end self-stretch', sideMetaJustify)}
        >
          {hasThreadActions && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      data-testid={`user-message-actions-menu-${props['data-testid'] ?? ''}`}
                      disabled={forkDisabled}
                      onClick={(e) => e.stopPropagation()}
                      className={cn(
                        'flex h-6 w-6 items-center justify-center rounded',
                        'bg-background/10 text-background/70 transition-opacity hover:bg-background/20 hover:text-background',
                        'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
                        forkDisabled && 'cursor-not-allowed opacity-50',
                      )}
                      aria-label={t('thread.threadActions', 'Thread actions')}
                    >
                      <MoreVertical className="icon-xs" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {t('thread.threadActions', 'Thread actions')}
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="end"
                className="w-64"
                onClick={(e) => e.stopPropagation()}
              >
                {onFork && (
                  <DropdownMenuItem
                    data-testid={`user-message-fork-${props['data-testid'] ?? ''}`}
                    disabled={forkDisabled}
                    onSelect={() => onFork()}
                  >
                    <GitBranch className="icon-xs" />
                    {t('thread.forkConversationFromHere', 'Fork conversation from here')}
                  </DropdownMenuItem>
                )}
                {onRewind && (
                  <DropdownMenuItem
                    data-testid={`user-message-rewind-${props['data-testid'] ?? ''}`}
                    disabled={forkDisabled || rewindDisabled}
                    title={rewindDisabled ? rewindDisabledReason : undefined}
                    onSelect={() => onRewind()}
                  >
                    <Undo2 className="icon-xs" />
                    {t('thread.rewindCodeToHere', 'Rewind code to here')}
                  </DropdownMenuItem>
                )}
                {onForkAndRewind && (
                  <DropdownMenuItem
                    data-testid={`user-message-fork-rewind-${props['data-testid'] ?? ''}`}
                    disabled={forkDisabled || rewindDisabled}
                    title={rewindDisabled ? rewindDisabledReason : undefined}
                    onSelect={() => onForkAndRewind()}
                  >
                    <RotateCcw className="icon-xs" />
                    {t('thread.forkAndRewindCode', 'Fork conversation and rewind code')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {timestamp && (
            <span className="text-background/50 text-right text-[10px] leading-4 whitespace-nowrap">
              {timeAgo(timestamp, t)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
