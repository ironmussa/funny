import { cn } from '@/lib/utils';
import { useWorkflowStore } from '@/stores/workflow-store';
import type { WorkflowRun, WorkflowStep } from '@/stores/workflow-store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CheckCircle, Circle, Loader2, XCircle, ArrowLeft } from 'lucide-react';

function StepIcon({ status }: { status: WorkflowStep['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle className="h-4 w-4 text-emerald-500" />;
    case 'running':
      return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-red-500" />;
    default:
      return <Circle className="h-4 w-4 text-muted-foreground" />;
  }
}

function StatusBadge({ status }: { status: WorkflowRun['status'] }) {
  const variant = status === 'completed'
    ? 'default'
    : status === 'failed'
      ? 'destructive'
      : 'secondary';
  return <Badge variant={variant} className="text-xs capitalize">{status}</Badge>;
}

export function WorkflowProgressPanel() {
  const selectedRunId = useWorkflowStore((s) => s.selectedRunId);
  const runs = useWorkflowStore((s) => s.runs);
  const selectRun = useWorkflowStore((s) => s.selectRun);

  const selectedRun = runs.find((r) => r.runId === selectedRunId);

  if (!selectedRun) {
    // Show run list
    return (
      <div className="h-full flex flex-col">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Workflow Runs</h2>
        </div>
        <ScrollArea className="flex-1">
          {runs.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">
              No workflow runs yet. Trigger a workflow from the project menu.
            </p>
          ) : (
            <div className="p-2 space-y-1">
              {runs.map((run) => (
                <button
                  key={run.runId}
                  onClick={() => selectRun(run.runId)}
                  className="w-full text-left px-3 py-2 rounded-md hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{run.workflowName}</span>
                    <StatusBadge status={run.status} />
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(run.startedAt).toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    );
  }

  // Show selected run details
  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <Button variant="ghost" size="icon-xs" onClick={() => selectRun(null)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold truncate">{selectedRun.workflowName}</h2>
        </div>
        <StatusBadge status={selectedRun.status} />
      </div>

      <ScrollArea className="flex-1 p-4">
        {/* Steps */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Steps</h3>
          {selectedRun.steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">Waiting for steps...</p>
          ) : (
            <div className="space-y-2">
              {selectedRun.steps.map((step) => (
                <div
                  key={step.name}
                  className={cn(
                    'flex items-start gap-2 rounded-md px-3 py-2 border',
                    step.status === 'completed' && 'border-emerald-500/20 bg-emerald-500/5',
                    step.status === 'running' && 'border-blue-500/20 bg-blue-500/5',
                    step.status === 'failed' && 'border-red-500/20 bg-red-500/5',
                    step.status === 'pending' && 'border-border',
                  )}
                >
                  <StepIcon status={step.status} />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{step.name}</span>
                    {step.completedAt && (
                      <p className="text-xs text-muted-foreground">
                        {new Date(step.completedAt).toLocaleTimeString()}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quality Scores */}
        {selectedRun.qualityScores && Object.keys(selectedRun.qualityScores).length > 0 && (
          <div className="mt-6 space-y-3">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Quality Scores</h3>
            <div className="space-y-2">
              {Object.entries(selectedRun.qualityScores).map(([name, score]) => (
                <div key={name} className="flex items-center justify-between rounded-md border px-3 py-2">
                  <span className="text-sm">{name}</span>
                  <Badge
                    variant={score.status === 'pass' ? 'default' : 'destructive'}
                    className="text-xs"
                  >
                    {score.status}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
