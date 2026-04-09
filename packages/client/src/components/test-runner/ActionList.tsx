import type { WSTestActionData } from '@funny/shared';
import {
  CheckCircle2,
  Circle,
  Loader2,
  MousePointerClick,
  Navigation,
  PenLine,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

interface ActionListProps {
  actions: WSTestActionData[];
  hoveredIndex: number;
  selectedIndex: number;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
}

/** Icon for an action based on its title/category. */
function ActionIcon({ action }: { action: WSTestActionData }) {
  const cls = 'h-3.5 w-3.5 shrink-0';

  if (action.error) return <XCircle className={cn(cls, 'text-destructive')} />;
  if (action.category === 'expect') {
    return action.endTime ? (
      <CheckCircle2 className={cn(cls, 'text-green-500')} />
    ) : (
      <Loader2 className={cn(cls, 'animate-spin text-muted-foreground')} />
    );
  }

  const title = action.title.toLowerCase();
  if (title.includes('goto') || title.includes('navigate')) {
    return <Navigation className={cn(cls, 'text-blue-400')} />;
  }
  if (title.includes('fill') || title.includes('type') || title.includes('press')) {
    return <PenLine className={cn(cls, 'text-amber-400')} />;
  }
  if (
    title.includes('click') ||
    title.includes('tap') ||
    title.includes('check') ||
    title.includes('uncheck')
  ) {
    return <MousePointerClick className={cn(cls, 'text-purple-400')} />;
  }

  // Default: generic step dot
  return action.endTime ? (
    <Circle className={cn(cls, 'text-muted-foreground')} />
  ) : (
    <Loader2 className={cn(cls, 'animate-spin text-muted-foreground')} />
  );
}

function formatMs(ms: number | undefined): string {
  if (ms == null) return '';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Extract just the action name without the full title for compact display. */
function shortTitle(title: string): string {
  // Already short enough
  if (title.length <= 60) return title;
  // Truncate but keep the first meaningful part
  return title.slice(0, 57) + '...';
}

export function ActionList({
  actions,
  hoveredIndex,
  selectedIndex,
  onHover,
  onSelect,
}: ActionListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const userScrolled = useRef(false);
  const activeIndex = hoveredIndex >= 0 ? hoveredIndex : selectedIndex;

  // Filter to only show user-facing actions (pw:api and expect), skip internal hooks/fixtures
  const visibleActions = actions.filter(
    (a) => a.category === 'pw:api' || a.category === 'expect' || a.category === 'test.step',
  );

  // Auto-scroll to latest action when live (no selection)
  useEffect(() => {
    if (!ref.current || userScrolled.current || selectedIndex >= 0) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [visibleActions.length, selectedIndex]);

  const handleScroll = () => {
    if (!ref.current) return;
    const { scrollTop, scrollHeight, clientHeight } = ref.current;
    userScrolled.current = scrollHeight - scrollTop - clientHeight > 40;
  };

  if (visibleActions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-2 text-center text-xs text-muted-foreground">
        Actions will appear here during test execution...
      </div>
    );
  }

  return (
    <div
      ref={ref}
      onScroll={handleScroll}
      className="h-full overflow-y-auto text-xs"
      data-testid="action-list"
    >
      {visibleActions.map((action) => {
        // Find the original index in the full actions array for hover/select
        const origIndex = actions.indexOf(action);
        const isActive = origIndex === activeIndex;

        return (
          <div
            key={action.id}
            className={cn(
              'flex cursor-pointer items-start gap-2 border-b border-border/20 px-2 py-1.5 transition-colors',
              isActive && 'bg-primary/10',
              !isActive && 'hover:bg-muted/40',
              action.error && 'bg-destructive/5',
            )}
            onMouseEnter={() => onHover(origIndex)}
            onMouseLeave={() => onHover(-1)}
            onClick={() => onSelect(origIndex === selectedIndex ? -1 : origIndex)}
            data-testid={`action-item-${action.id}`}
          >
            <div className="mt-0.5">
              <ActionIcon action={action} />
            </div>
            <div className="min-w-0 flex-1">
              <div
                className={cn(
                  'truncate font-mono',
                  action.error ? 'text-destructive' : 'text-foreground',
                )}
                title={action.title}
              >
                {shortTitle(action.title)}
              </div>
              {action.duration != null && (
                <div className="mt-0.5 text-muted-foreground">{formatMs(action.duration)}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
