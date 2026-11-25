import type { WorkflowSummary } from '@funny/shared/types/workflows';
import { GitBranch, Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface WorkflowsSidebarProps {
  summaries: WorkflowSummary[];
  selectedName: string | null;
  filter: string;
  onFilterChange: (value: string) => void;
  onSelect: (name: string) => void;
}

export function WorkflowsSidebar({
  summaries,
  selectedName,
  filter,
  onFilterChange,
  onSelect,
}: WorkflowsSidebarProps) {
  return (
    <aside className="border-border bg-sidebar/40 flex w-72 shrink-0 flex-col border-r">
      <div className="border-border border-b p-3">
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-2.5 left-2 size-4" />
          <Input
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder="Filter workflows"
            inset="icon"
          />
        </div>
      </div>
      <WorkflowList
        summaries={summaries}
        selectedName={selectedName}
        filter={filter}
        onSelect={onSelect}
      />
    </aside>
  );
}

function WorkflowList({
  summaries,
  selectedName,
  filter,
  onSelect,
}: {
  summaries: WorkflowSummary[];
  selectedName: string | null;
  filter: string;
  onSelect: (name: string) => void;
}) {
  const normalized = filter.trim().toLowerCase();
  const visible = normalized
    ? summaries.filter((item) =>
        `${item.name} ${item.description ?? ''}`.toLowerCase().includes(normalized),
      )
    : summaries;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="text-muted-foreground px-3 py-2 text-xs font-medium uppercase">Workflows</div>
      <div className="min-h-0 flex-1 overflow-auto p-1">
        {visible.map((item) => (
          <button
            key={item.name}
            onClick={() => onSelect(item.name)}
            className={cn(
              'hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm',
              selectedName === item.name && 'bg-accent text-accent-foreground',
            )}
          >
            <GitBranch className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            <span className="text-muted-foreground text-compact">
              {item.source === 'user' ? 'user' : 'base'}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
