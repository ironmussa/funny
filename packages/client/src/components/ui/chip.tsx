import { Code2, FileText, FolderOpen, Loader2, X, Zap, type LucideIcon } from 'lucide-react';
import type { MouseEvent } from 'react';

import { cn } from '@/lib/utils';

export type ChipVariant = 'default' | 'inverse';

const CHIP_BASE =
  'mx-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 align-middle font-mono text-xs whitespace-nowrap';

const CHIP_VARIANTS: Record<ChipVariant, string> = {
  // Light surface (e.g. prompt editor) — semi-transparent foreground tint
  default: 'bg-foreground/10 text-foreground border border-foreground/20',
  // Dark surface (e.g. UserMessageCard with bg-foreground) — inverted
  inverse: 'bg-background/20 text-background/70',
};

interface ChipProps {
  icon: LucideIcon;
  label: string;
  variant?: ChipVariant;
  title?: string;
  className?: string;
  'data-testid'?: string;
}

/** Base inline chip used to render mentions / commands / references. */
export function Chip({
  icon: Icon,
  label,
  variant = 'default',
  title,
  className,
  ...props
}: ChipProps) {
  return (
    <span
      data-testid={props['data-testid']}
      title={title}
      className={cn(CHIP_BASE, CHIP_VARIANTS[variant], className)}
    >
      <Icon className="icon-xs shrink-0" />
      {label}
    </span>
  );
}

interface SkillChipProps {
  name: string;
  variant?: ChipVariant;
  className?: string;
  'data-testid'?: string;
}

/** Chip for slash-command / skill references (e.g. `/query-logs`). */
export function SkillChip({
  name,
  variant,
  className,
  'data-testid': testId = 'skill-chip',
}: SkillChipProps) {
  return (
    <Chip icon={Zap} label={name} variant={variant} className={className} data-testid={testId} />
  );
}

interface FileChipProps {
  /** Display label (e.g. file basename). */
  name: string;
  type: 'file' | 'folder';
  /** Full path shown on hover. */
  title?: string;
  variant?: ChipVariant;
  className?: string;
  'data-testid'?: string;
}

/** Chip for file/folder references attached or @-mentioned in a prompt. */
export function FileChip({
  name,
  type,
  title,
  variant,
  className,
  'data-testid': testId = 'file-chip',
}: FileChipProps) {
  return (
    <Chip
      icon={type === 'folder' ? FolderOpen : FileText}
      label={name}
      variant={variant}
      title={title}
      className={className}
      data-testid={testId}
    />
  );
}

interface SymbolChipProps {
  name: string;
  variant?: ChipVariant;
  className?: string;
  'data-testid'?: string;
}

/** Chip for `#symbol` references in a prompt. */
export function SymbolChip({
  name,
  variant,
  className,
  'data-testid': testId = 'symbol-chip',
}: SymbolChipProps) {
  return (
    <Chip icon={Code2} label={name} variant={variant} className={className} data-testid={testId} />
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
  return (
    <div
      data-testid={testId}
      title={title}
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
    </div>
  );
}
