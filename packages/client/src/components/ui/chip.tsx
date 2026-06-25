import { Code2, ExternalLink, FileText, FolderOpen, Loader2, X, Zap } from 'lucide-react';
import type { ComponentType, MouseEvent, ReactNode } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type ChipVariant = 'default' | 'inverse';
export type ChipSize = 'xs' | 'sm' | 'xxs';
export type ChipIcon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

const CHIP_BASE =
  'mx-0.5 inline-flex items-center gap-1 rounded align-middle font-mono leading-none whitespace-nowrap focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none';

const CHIP_SIZES: Record<ChipSize, string> = {
  xs: 'px-1.5 py-0.5 text-xs',
  sm: 'h-5 px-1.5 text-xs',
  xxs: 'h-4 gap-0.5 rounded-[3px] px-1 text-[10px]',
};

const CHIP_VARIANTS: Record<ChipVariant, string> = {
  // Light surface (e.g. prompt editor) — semi-transparent foreground tint
  default: 'bg-foreground/10 text-foreground border border-foreground/20',
  // Dark surface (e.g. UserMessageCard with bg-foreground) — inverted
  inverse: 'bg-background/20 text-background/70',
};

function withChipTooltip(content: ReactNode, title?: string) {
  if (!title) return content;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent className="max-w-[min(32rem,calc(100vw-2rem))] font-mono break-all">
        {title}
      </TooltipContent>
    </Tooltip>
  );
}

interface ChipProps {
  icon?: ChipIcon;
  label: ReactNode;
  href?: string;
  ariaLabel?: string;
  showExternalIcon?: boolean;
  variant?: ChipVariant;
  size?: ChipSize;
  title?: string;
  className?: string;
  'data-testid'?: string;
}

/** Base inline chip used to render mentions / commands / references. */
export function Chip({
  icon: Icon,
  label,
  href,
  ariaLabel,
  showExternalIcon,
  variant = 'default',
  size = 'xs',
  title,
  className,
  ...props
}: ChipProps) {
  const content = (
    <>
      {Icon ? <Icon className="icon-xs shrink-0" aria-hidden={true} /> : null}
      {label}
      {href && showExternalIcon ? (
        <ExternalLink className="icon-xs shrink-0" aria-hidden={true} />
      ) : null}
    </>
  );
  const chipClassName = cn(CHIP_BASE, CHIP_SIZES[size], CHIP_VARIANTS[variant], className);

  if (href) {
    return withChipTooltip(
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        aria-label={ariaLabel}
        data-testid={props['data-testid']}
        className={chipClassName}
      >
        {content}
      </a>,
      title,
    );
  }

  return withChipTooltip(
    <span data-testid={props['data-testid']} aria-label={ariaLabel} className={chipClassName}>
      {content}
    </span>,
    title,
  );
}

interface SkillChipProps {
  name: string;
  variant?: ChipVariant;
  size?: ChipSize;
  className?: string;
  'data-testid'?: string;
}

/** Chip for slash-command / skill references (e.g. `/query-logs`). */
export function SkillChip({
  name,
  variant,
  size,
  className,
  'data-testid': testId = 'skill-chip',
}: SkillChipProps) {
  return (
    <Chip
      icon={Zap}
      label={name}
      variant={variant}
      size={size}
      className={className}
      data-testid={testId}
    />
  );
}

interface CommandLineChipProps {
  command: string;
  variant?: ChipVariant;
  size?: ChipSize;
  className?: string;
  'data-testid'?: string;
}

/** Chip for command-line prompts sent with `!` (rendered with a shell `>` marker). */
export function CommandLineChip({
  command,
  variant,
  size = 'xs',
  className,
  'data-testid': testId = 'command-line-chip',
}: CommandLineChipProps) {
  return withChipTooltip(
    <span
      data-testid={testId}
      className={cn(
        CHIP_BASE,
        CHIP_SIZES[size],
        CHIP_VARIANTS[variant ?? 'default'],
        'max-w-full',
        className,
      )}
    >
      <span aria-hidden="true" className="shrink-0 font-semibold">
        &gt;
      </span>
      <span className="min-w-0 truncate">{command}</span>
    </span>,
    command,
  );
}

interface FileChipProps {
  /** Display label (e.g. file basename). */
  name: string;
  type: 'file' | 'folder';
  /** Full path shown on hover. */
  title?: string;
  variant?: ChipVariant;
  size?: ChipSize;
  className?: string;
  'data-testid'?: string;
}

/** Chip for file/folder references attached or @-mentioned in a prompt. */
export function FileChip({
  name,
  type,
  title,
  variant,
  size,
  className,
  'data-testid': testId = 'file-chip',
}: FileChipProps) {
  return (
    <Chip
      icon={type === 'folder' ? FolderOpen : FileText}
      label={name}
      variant={variant}
      size={size}
      title={title}
      className={className}
      data-testid={testId}
    />
  );
}

interface SymbolChipProps {
  name: string;
  variant?: ChipVariant;
  size?: ChipSize;
  className?: string;
  'data-testid'?: string;
}

/** Chip for `#symbol` references in a prompt. */
export function SymbolChip({
  name,
  variant,
  size,
  className,
  'data-testid': testId = 'symbol-chip',
}: SymbolChipProps) {
  return (
    <Chip
      icon={Code2}
      label={name}
      variant={variant}
      size={size}
      className={className}
      data-testid={testId}
    />
  );
}

interface AttachmentChipProps {
  name: string;
  /** Formatted size (e.g. "12 KB", "1.2 MB"). */
  size?: string;
  /** Show a spinner instead of the file icon while uploading. */
  loading?: boolean;
  /** When set, renders a dismiss button. */
  onRemove?: (e: MouseEvent<HTMLButtonElement>) => void;
  removeDisabled?: boolean;
  removeLabel?: string;
  variant?: ChipVariant;
  title?: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * Larger chip for file attachments in a prompt — supports size metadata,
 * loading state, and an optional dismiss button. Visually consistent with
 * the inline chip family but sized for a removable affordance.
 */
export function AttachmentChip({
  name,
  size,
  loading = false,
  onRemove,
  removeDisabled = false,
  removeLabel = 'Remove attachment',
  variant = 'default',
  title,
  className,
  'data-testid': testId,
}: AttachmentChipProps) {
  return withChipTooltip(
    <div
      data-testid={testId}
      className={cn(
        'group inline-flex h-7 items-center gap-1.5 rounded font-mono text-xs',
        CHIP_VARIANTS[variant],
        onRemove ? 'pl-2 pr-1' : 'px-2',
        className,
      )}
    >
      {loading ? (
        <Loader2 className="icon-xs shrink-0 animate-spin opacity-70" />
      ) : (
        <FileText className="icon-xs shrink-0 opacity-70" />
      )}
      <span className="max-w-[160px] truncate">{name}</span>
      {size && <span className="shrink-0 opacity-60">{size}</span>}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          disabled={removeDisabled}
          className="hover:bg-destructive hover:text-destructive-foreground rounded p-0.5 opacity-70 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <X className="icon-xs" />
        </button>
      )}
    </div>,
    title,
  );
}
