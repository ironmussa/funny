import { ChevronRight, Wrench, ListTodo } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import { getToolLabel } from './tool-cards/utils';
import { ToolCallCard } from './ToolCallCard';

interface ToolCallItem {
  id: string;
  name: string;
  input: string | Record<string, unknown>;
  output?: string;
}

interface ToolCallGroupProps {
  name: string;
  calls: ToolCallItem[];
  onRespond?: (answer: string) => void;
}

export function ToolCallGroup({ name, calls, onRespond }: ToolCallGroupProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const label = getToolLabel(name, t);
  const isTodo = name === 'TodoWrite';

  return (
    <div className="max-w-full overflow-hidden text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/30"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
        {isTodo ? (
          <ListTodo className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        ) : (
          <Wrench className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        )}
        <span className="flex-shrink-0 font-mono font-medium text-foreground">{label}</span>
        <span className="inline-flex items-center justify-center rounded-full bg-muted-foreground/20 px-1.5 text-xs font-medium leading-4 text-muted-foreground">
          ×{calls.length}
        </span>
      </button>
      {expanded && (
        <div className="space-y-1.5 border-t border-border/40 px-2 pb-2 pt-1">
          {calls.map((tc) => (
            <ToolCallCard
              key={tc.id}
              name={tc.name}
              input={tc.input}
              output={tc.output}
              onRespond={onRespond}
              hideLabel
            />
          ))}
        </div>
      )}
    </div>
  );
}
