import type { WSTestActionData } from '@funny/shared';
import { useMemo } from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface ActionTimelineProps {
  actions: WSTestActionData[];
  hoveredIndex: number;
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
}

const CATEGORY_COLORS: Record<string, string> = {
  'pw:api': 'bg-blue-400',
  expect: 'bg-green-500',
  'test.step': 'bg-purple-400',
  hook: 'bg-gray-400',
  fixture: 'bg-gray-400',
};

function formatTimeLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ActionTimeline({
  actions,
  hoveredIndex,
  selectedIndex,
  onHover,
  onSelect,
}: ActionTimelineProps) {
  const activeIndex = hoveredIndex >= 0 ? hoveredIndex : selectedIndex;

  // Only show user-facing actions
  const visibleActions = useMemo(
    () =>
      actions.filter(
        (a) => a.category === 'pw:api' || a.category === 'expect' || a.category === 'test.step',
      ),
    [actions],
  );

  const { testStart, totalDuration } = useMemo(() => {
    if (visibleActions.length === 0) return { testStart: 0, totalDuration: 0 };
    const starts = visibleActions.flatMap((a) => (a.startTime ? [a.startTime] : []));
    const ends = visibleActions.flatMap((a) => {
      const v = (a.endTime ?? a.startTime) + (a.duration ?? 0);
      return v ? [v] : [];
    });
    const start = Math.min(...starts);
    const end = Math.max(...ends, start + 1);
    return { testStart: start, totalDuration: end - start };
  }, [visibleActions]);

  if (visibleActions.length === 0 || totalDuration === 0) {
    return null;
  }

  return (
    <div
      className="bg-muted/20 relative flex h-6 items-center border-b px-1"
      data-testid="action-timeline"
    >
      {/* Track background */}
      <div className="bg-muted/40 relative h-3 w-full rounded-sm">
        {/* Action markers */}
        {visibleActions.map((action) => {
          const origIndex = actions.indexOf(action);
          const left = ((action.startTime - testStart) / totalDuration) * 100;
          const dur = action.duration ?? 0;
          const width = Math.max((dur / totalDuration) * 100, 0.5); // min 0.5% visible
          const isActive = origIndex === activeIndex;
          const colorClass = action.error
            ? 'bg-destructive'
            : (CATEGORY_COLORS[action.category] ?? 'bg-gray-400');

          const tooltipLabel = `${action.title} (${formatTimeLabel(dur)})`;

          return (
            <Tooltip key={action.id}>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    'absolute top-0 h-full cursor-pointer rounded-[1px] transition-opacity',
                    colorClass,
                    isActive
                      ? 'opacity-100 ring-1 ring-foreground/40'
                      : 'opacity-60 hover:opacity-90',
                  )}
                  style={{
                    left: `${Math.min(left, 99.5)}%`,
                    width: `${Math.max(width, 0.5)}%`,
                  }}
                  onMouseEnter={() => onHover(origIndex)}
                  onMouseLeave={() => onHover(-1)}
                  onClick={() => onSelect(origIndex === selectedIndex ? -1 : origIndex)}
                  data-testid={`timeline-marker-${action.id}`}
                />
              </TooltipTrigger>
              <TooltipContent className="max-w-[min(36rem,calc(100vw-2rem))] break-words">
                {tooltipLabel}
              </TooltipContent>
            </Tooltip>
          );
        })}

        {/* Playhead for active action */}
        {activeIndex >= 0 && activeIndex < actions.length && (
          <div
            className="bg-foreground/70 absolute top-0 h-full w-px"
            style={{
              left: `${Math.min(
                ((actions[activeIndex].startTime - testStart) / totalDuration) * 100,
                100,
              )}%`,
            }}
          />
        )}
      </div>

      {/* Time labels */}
      <div className="pointer-events-none absolute inset-x-1 top-0 flex h-full items-center justify-between">
        <span className="text-muted-foreground/60 text-[9px]">0s</span>
        <span className="text-muted-foreground/60 text-[9px]">
          {formatTimeLabel(totalDuration)}
        </span>
      </div>
    </div>
  );
}
