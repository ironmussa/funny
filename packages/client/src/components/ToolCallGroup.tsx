import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Wrench, ListTodo } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolCallCard } from './ToolCallCard';
import { getToolLabel } from './tool-cards/utils';

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
    <div className="text-sm max-w-full overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left text-xs hover:bg-accent/30 transition-colors rounded-md overflow-hidden"
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-90'
          )}
        />
        {isTodo ? (
          <ListTodo className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        ) : (
          <Wrench className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        )}
        <span className="font-medium font-mono text-foreground flex-shrink-0">{label}</span>
        <span className="inline-flex items-center justify-center bg-muted-foreground/20 text-muted-foreground px-1.5 rounded-full text-xs font-medium leading-4">
          ×{calls.length}
        </span>
      </button>
      {expanded && (
        <div className="px-2 pb-2 pt-1 space-y-1.5 border-t border-border/40">
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
