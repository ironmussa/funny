import { ChevronRight, Wrench, ListTodo } from 'lucide-react';
import { useState, memo, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useMinuteTick } from '@/hooks/use-minute-tick';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

import { getToolLabel, isTodoToolName } from './tool-cards/utils';

export interface ToolCallItem {
  id: string;
  name: string;
  input: string | Record<string, unknown>;
  output?: string;
}

export interface ToolCallGroupProps {
  name: string;
  calls: ToolCallItem[];
  timestamp?: string;
  /**
   * Renderer for individual tool calls inside the expanded group. Injected by
   * the parent so this component doesn't import `ToolCallCard` directly —
   * that would form a static import cycle.
   */
  renderCall?: (call: ToolCallItem & { _childToolCalls?: any[] }) => ReactNode;
}

function toolCallGroupAreEqual(prev: ToolCallGroupProps, next: ToolCallGroupProps) {
  if (
    prev.name !== next.name ||
    prev.renderCall !== next.renderCall ||
    prev.timestamp !== next.timestamp
  )
    return false;
  if (prev.calls === next.calls) return true;
  if (prev.calls.length !== next.calls.length) return false;
  for (let i = 0; i < prev.calls.length; i++) {
    if (prev.calls[i] !== next.calls[i]) return false;
  }
  return true;
}

export const ToolCallGroup = memo(function ToolCallGroup({
  name,
  calls,
  timestamp,
  renderCall,
}: ToolCallGroupProps) {
  const { t } = useTranslation();
  const tick = useMinuteTick(); // re-render every 60s so timeAgo stays fresh (memo blocks parent ticks)
  const [expanded, setExpanded] = useState(false);
  const isTodo = isTodoToolName(name);
  const label = getToolLabel(isTodo ? 'TodoWrite' : name, t);
  const displayTime = useMemo(
    () => (timestamp ? timeAgo(timestamp, t) : null),
    [timestamp, t, tick],
  );

  return (
    <div className="border-border max-w-full overflow-hidden rounded-lg border text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="hover:bg-accent/30 w-full overflow-hidden rounded-md px-3 py-1.5 text-left text-xs transition-colors"
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            className={cn(
              'icon-xs shrink-0 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
          {isTodo ? (
            <ListTodo className="icon-xs text-muted-foreground shrink-0" />
          ) : (
            <Wrench className="icon-xs text-muted-foreground shrink-0" />
          )}
          <span className="text-foreground shrink-0 font-mono font-medium">{label}</span>
          <span className="bg-muted-foreground/20 text-muted-foreground inline-flex items-center justify-center rounded-full px-1.5 text-xs leading-4 font-medium">
            ×{calls.length}
          </span>
          {displayTime && (
            <span className="text-muted-foreground/50 ml-auto shrink-0 text-[10px] tabular-nums">
              {displayTime}
            </span>
          )}
        </div>
      </button>
      {expanded && renderCall && (
        <div className="border-border/40 space-y-1.5 border-t px-2 pt-1 pb-2">
          {calls.map((tc) => renderCall(tc))}
        </div>
      )}
    </div>
  );
}, toolCallGroupAreEqual);
