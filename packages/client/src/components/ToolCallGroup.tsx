import { ChevronRight, Wrench, ListTodo } from 'lucide-react';
import { useState, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

import { getToolLabel } from './tool-cards/utils';
import { ToolCallCard } from './ToolCallCard';

export interface ToolCallItem {
  id: string;
  name: string;
  input: string | Record<string, unknown>;
  output?: string;
}

export interface ToolCallGroupProps {
  name: string;
  calls: ToolCallItem[];
  onRespond?: (answer: string) => void;
  timestamp?: string;
}

function toolCallGroupAreEqual(prev: ToolCallGroupProps, next: ToolCallGroupProps) {
  if (
    prev.name !== next.name ||
    prev.onRespond !== next.onRespond ||
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
  onRespond,
  timestamp,
}: ToolCallGroupProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const label = getToolLabel(name, t);
  const isTodo = name === 'TodoWrite';
  const displayTime = useMemo(() => (timestamp ? timeAgo(timestamp, t) : null), [timestamp, t]);

  return (
    <div className="max-w-full overflow-hidden rounded-lg border border-border text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full overflow-hidden rounded-md px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/30"
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            className={cn(
              'icon-xs flex-shrink-0 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
          {isTodo ? (
            <ListTodo className="icon-xs flex-shrink-0 text-muted-foreground" />
          ) : (
            <Wrench className="icon-xs flex-shrink-0 text-muted-foreground" />
          )}
          <span className="flex-shrink-0 font-mono font-medium text-foreground">{label}</span>
          <span className="inline-flex items-center justify-center rounded-full bg-muted-foreground/20 px-1.5 text-xs font-medium leading-4 text-muted-foreground">
            ×{calls.length}
          </span>
          {displayTime && (
            <span className="ml-auto flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
              {displayTime}
            </span>
          )}
        </div>
      </button>
      {expanded && (
        <div className="space-y-1.5 border-t border-border/40 px-2 pb-2 pt-1">
          {calls.map((tc: any) => (
            <ToolCallCard
              key={tc.id}
              name={tc.name}
              input={tc.input}
              output={tc.output}
              onRespond={onRespond}
              hideLabel
              childToolCalls={tc._childToolCalls}
            />
          ))}
        </div>
      )}
    </div>
  );
}, toolCallGroupAreEqual);
