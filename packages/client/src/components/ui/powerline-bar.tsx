import { Copy } from 'lucide-react';
import * as React from 'react';
import { toast } from 'sonner';

import { cn, ICON_SIZE } from '@/lib/utils';

import { HighlightText } from './highlight-text';
import { contrastText, darkenHex } from './project-chip';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

type PowerlineVariant = 'arrow' | 'chips' | 'plain';

/** Read --powerline-variant from the current theme CSS (defaults to 'arrow'). */
function useThemeVariant(): PowerlineVariant {
  const [variant, setVariant] = React.useState<PowerlineVariant>('arrow');
  React.useEffect(() => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--powerline-variant')
      .trim();
    if (raw === 'chips') setVariant('chips');
    else if (raw === 'plain') setVariant('plain');
    else setVariant('arrow');
  }, []);
  return variant;
}

export interface PowerlineSegmentData {
  /** Unique key for React rendering */
  key: string;
  /** Optional Lucide icon component */
  icon?: React.ComponentType<{ className?: string }>;
  /** Text label for the segment */
  label: string;
  /** Background color as a hex string (e.g. '#7CB9E8') */
  color: string;
  /** Text color — auto-calculated via contrastText() if omitted */
  textColor?: string;
  /** Custom tooltip text — defaults to the label if omitted */
  tooltip?: string;
  /** Render the label bold to mark it as the active/current segment. */
  emphasis?: boolean;
  /**
   * When set, the segment becomes interactive: hovering swaps its icon for a
   * copy glyph and clicking copies this string to the clipboard.
   */
  copyValue?: string;
}

export interface PowerlineBarProps {
  /** Ordered array of segments to render left-to-right */
  segments: PowerlineSegmentData[];
  /** Size variant */
  size?: 'sm' | 'md';
  /** Visual style: "arrow" (powerline chevrons), "chips" (rounded pills), or
   *  "plain" (monochrome text with separator, no colors).
   *  When omitted, falls back to the theme's --powerline-variant CSS variable (default: arrow). */
  variant?: PowerlineVariant;
  /** Active search query — when set, the matching substring of each segment
   *  label is highlighted with the shared {@link HighlightText} mark. */
  query?: string;
  /** Additional class names for the outer container */
  className?: string;
  'data-testid'?: string;
}

const sizeConfig = {
  sm: {
    arrow: 8,
    padding: 'px-1.5 py-px',
    text: 'text-[10px] leading-tight',
    icon: ICON_SIZE['2xs'],
  },
  md: {
    arrow: 10,
    padding: 'px-2 py-0.5',
    text: 'text-[11px] leading-tight',
    icon: ICON_SIZE.xs,
  },
} as const;

/**
 * Compute a drop-shadow-sm filter that gives the clipped arrow shape a visible
 * edge.  Uses a darkened shade of the segment's own color so the divider
 * blends naturally instead of appearing as a harsh white/black line.
 */
function arrowEdgeShadow(color: string): string {
  const darker = darkenHex(color, 0.35);
  return `drop-shadow(1px 0 0 ${darker})`;
}

function copyToClipboard(value: string) {
  void navigator.clipboard.writeText(value);
  toast.success('Copied to clipboard');
}

/**
 * Renders a segment's icon. When the segment is copyable, the original icon is
 * swapped for a {@link Copy} glyph on hover (scoped to the segment via the
 * `group/seg` hover group).
 */
function SegmentIcon({
  Icon,
  copyable,
  className,
}: {
  Icon?: React.ComponentType<{ className?: string }>;
  copyable: boolean;
  className: string;
}) {
  if (copyable) {
    return (
      <>
        {Icon && (
          <Icon className={cn(className, 'shrink-0 group-hover/seg:hidden')} aria-hidden="true" />
        )}
        <Copy
          className={cn(className, 'hidden shrink-0 group-hover/seg:block', !Icon && 'block')}
          aria-hidden="true"
        />
      </>
    );
  }
  return Icon ? <Icon className={cn(className, 'shrink-0')} aria-hidden="true" /> : null;
}

/** Build the interaction props (click/keyboard to copy) for a copyable segment. */
function copyInteractionProps(value: string | undefined) {
  if (!value) return {};
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      copyToClipboard(value);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        copyToClipboard(value);
      }
    },
  };
}

export function PowerlineBar({
  segments,
  size = 'md',
  variant: variantProp,
  className,
  query,
  ...props
}: PowerlineBarProps) {
  const themeVariant = useThemeVariant();
  const variant = variantProp ?? themeVariant;

  if (segments.length === 0) return null;
  const config = sizeConfig[size];

  // When a search query is active, mark the matching substring of the label;
  // otherwise render the bare string (HighlightText would no-op anyway).
  const renderLabel = (label: string) =>
    query?.trim() ? <HighlightText text={label} query={query} /> : label;

  const renderSegmentLabel = (segment: PowerlineSegmentData) => (
    <span
      className={cn(
        config.text,
        'truncate font-medium whitespace-nowrap',
        segment.emphasis && 'font-bold',
      )}
    >
      {renderLabel(segment.label)}
    </span>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn(
          'inline-flex items-center min-w-0',
          variant === 'chips' && 'gap-1',
          variant === 'plain' && 'gap-1',
          className,
        )}
        data-testid={props['data-testid']}
      >
        {segments.map((segment, i) => {
          const isFirst = i === 0;
          const isLast = i === segments.length - 1;
          const textColor = segment.textColor || contrastText(segment.color);
          const Icon = segment.icon;
          const copyable = !!segment.copyValue;
          const interaction = copyInteractionProps(segment.copyValue);

          if (variant === 'plain') {
            return (
              <React.Fragment key={segment.key}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div
                      className={cn(
                        'group/seg inline-flex items-center gap-1 min-w-0 text-muted-foreground',
                        copyable && 'cursor-pointer hover:text-foreground',
                      )}
                      data-testid={`powerline-segment-${segment.key}`}
                      {...interaction}
                    >
                      <SegmentIcon Icon={Icon} copyable={copyable} className={config.icon} />
                      {renderSegmentLabel(segment)}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>{segment.tooltip || segment.label}</TooltipContent>
                </Tooltip>
                {!isLast && (
                  <span
                    aria-hidden="true"
                    className={cn(config.text, 'text-muted-foreground/50 select-none')}
                  >
                    /
                  </span>
                )}
              </React.Fragment>
            );
          }

          if (variant === 'chips') {
            return (
              <Tooltip key={segment.key}>
                <TooltipTrigger asChild>
                  <div
                    className={cn(
                      'group/seg inline-flex items-center gap-0.5 min-w-0 rounded-full',
                      config.padding,
                      copyable && 'cursor-pointer',
                    )}
                    style={{ backgroundColor: segment.color, color: textColor }}
                    data-testid={`powerline-segment-${segment.key}`}
                    {...interaction}
                  >
                    <SegmentIcon Icon={Icon} copyable={copyable} className={config.icon} />
                    {renderSegmentLabel(segment)}
                  </div>
                </TooltipTrigger>
                <TooltipContent>{segment.tooltip || segment.label}</TooltipContent>
              </Tooltip>
            );
          }

          return (
            <Tooltip key={segment.key}>
              <TooltipTrigger asChild>
                {/* Outer wrapper applies drop-shadow-sm that follows the clipped
                    arrow shape of the inner div, creating a visible edge
                    between segments even when they share the same color. */}
                <div
                  className={cn(
                    'group/seg relative inline-flex min-w-0 shrink',
                    copyable && 'cursor-pointer',
                  )}
                  style={{
                    zIndex: segments.length - i,
                    marginLeft: !isFirst ? `-${config.arrow}px` : undefined,
                    filter: !isLast ? arrowEdgeShadow(segment.color) : undefined,
                  }}
                  data-testid={`powerline-segment-${segment.key}`}
                  {...interaction}
                >
                  <div
                    className={cn(
                      'inline-flex items-center gap-0.5 min-w-0 w-full',
                      config.padding,
                      isFirst && 'rounded-l-sm',
                    )}
                    style={{
                      backgroundColor: segment.color,
                      color: textColor,
                      paddingRight: `calc(${config.arrow}px + 0.25rem)`,
                      paddingLeft: !isFirst ? `calc(${config.arrow}px + 0.375rem)` : undefined,
                      clipPath: `polygon(0 0, calc(100% - ${config.arrow}px) 0, 100% 50%, calc(100% - ${config.arrow}px) 100%, 0 100%)`,
                    }}
                  >
                    <SegmentIcon Icon={Icon} copyable={copyable} className={config.icon} />
                    {renderSegmentLabel(segment)}
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>{segment.tooltip || segment.label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
