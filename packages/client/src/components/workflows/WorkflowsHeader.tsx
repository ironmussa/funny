import type { WorkflowDefinitionResponse } from '@funny/shared/types/workflows';
import { GitBranch, Play, RefreshCw, Save, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface WorkflowsHeaderProps {
  definition: WorkflowDefinitionResponse | null;
  selectedName: string | null;
  hasErrors: boolean;
  selectedThreadId: string | null;
  activeRunId: string | null;
  refreshFromSource: () => Promise<void>;
  saveWorkflow: () => Promise<void>;
  runWorkflow: () => Promise<void>;
  cancelRun: () => Promise<void>;
}

export function WorkflowsHeader({
  definition,
  selectedName,
  hasErrors,
  selectedThreadId,
  activeRunId,
  refreshFromSource,
  saveWorkflow,
  runWorkflow,
  cancelRun,
}: WorkflowsHeaderProps) {
  return (
    <header className="border-border bg-background flex h-12 shrink-0 items-center gap-3 border-b px-4">
      <GitBranch className="text-muted-foreground icon-base" />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-semibold">Workflows</h1>
        {definition?.summary.source === 'built-in' ? (
          <p className="text-muted-foreground truncate text-xs">
            Saving writes `.funny/workflows/{definition.summary.name}.yaml`.
          </p>
        ) : null}
      </div>
      <Button variant="outline" size="sm" onClick={() => void refreshFromSource()}>
        <RefreshCw className="size-4" />
      </Button>
      <Button size="sm" onClick={() => void saveWorkflow()} disabled={!selectedName || hasErrors}>
        <Save className="size-4" />
        Save
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void runWorkflow()}
        disabled={!selectedName || hasErrors || !selectedThreadId}
      >
        <Play className="size-4" />
        Run
      </Button>
      <Button size="sm" variant="outline" onClick={() => void cancelRun()} disabled={!activeRunId}>
        <Square className="size-4" />
      </Button>
    </header>
  );
}
