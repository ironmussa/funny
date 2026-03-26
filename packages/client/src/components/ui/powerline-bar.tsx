import * as React from 'react';

import { cn, ICON_SIZE } from '@/lib/utils';

import { contrastText } from './project-chip';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

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
}

export interface PowerlineBarProps {
  /** Ordered array of segments to render left-to-right */
  segments: PowerlineSegmentData[];
  /** Size variant */
  size?: 'sm' | 'md';
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
 * Compute a drop-shadow filter that gives the clipped arrow shape a visible
 * edge.  Uses a contrasting semi-transparent color (white on dark backgrounds,
 * black on light backgrounds) so adjacent segments with identical colors still
 * show a clear boundary.
 */
function arrowEdgeShadow(color: string): string {
  const edge = contrastText(color);
  // White edges need a bit more opacity to be visible; black edges are naturally heavier
  const alpha = edge === '#ffffff' ? 0.45 : 0.25;
  const rgba = edge === '#ffffff' ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`;
  // 1px shadow in the arrow direction (positive-x) outlines the right edge
  return `drop-shadow(1px 0 0 ${rgba})`;
}

export function PowerlineBar({ segments, size = 'md', className, ...props }: PowerlineBarProps) {
  if (segments.length === 0) return null;
  const config = sizeConfig[size];

  return (
    <TooltipProvider delayDuration={300}>
      <div
        className={cn('inline-flex items-center min-w-0', className)}
        data-testid={props['data-testid']}
      >
        {segments.map((segment, i) => {
          const isFirst = i === 0;
          const isLast = i === segments.length - 1;
          const textColor = segment.textColor || contrastText(segment.color);
          const Icon = segment.icon;

          return (
            <Tooltip key={segment.key}>
              <TooltipTrigger asChild>
                {/* Outer wrapper applies drop-shadow that follows the clipped
                    arrow shape of the inner div, creating a visible edge
                    between segments even when they share the same color. */}
                <div
                  className="relative inline-flex min-w-0 shrink"
                  style={{
                    zIndex: segments.length - i,
                    marginLeft: !isFirst ? `-${config.arrow}px` : undefined,
                    filter: !isLast ? arrowEdgeShadow(segment.color) : undefined,
                  }}
                  data-testid={`powerline-segment-${segment.key}`}
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
                    {Icon && <Icon className={cn(config.icon, 'shrink-0')} aria-hidden="true" />}
                    <span className={cn(config.text, 'truncate font-medium whitespace-nowrap')}>
                      {segment.label}
                    </span>
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
