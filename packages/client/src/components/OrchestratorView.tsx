import { Activity, RefreshCw, Hourglass, Zap, Clock } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useOrchestratorStore } from '@/stores/orchestrator-store';
import { useThreadStore } from '@/stores/thread-store';

type RunStatus = 'dispatched' | 'claimed' | 'retry-queued';

function deriveStatus(run: {
  pipelineRunId: string | null;
  nextRetryAtMs: number | null;
}): RunStatus {
  if (run.nextRetryAtMs && run.nextRetryAtMs > 0) return 'retry-queued';
  if (run.pipelineRunId) return 'dispatched';
  return 'claimed';
}

function StatusBadge({ status }: { status: RunStatus }) {
  if (status === 'dispatched') {
    return (
      <Badge variant="default" className="gap-1">
        <Zap className="icon-2xs" /> dispatched
      </Badge>
    );
  }
  if (status === 'retry-queued') {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-600">
        <Hourglass className="icon-2xs" /> retry-queued
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <Clock className="icon-2xs" /> claimed
    </Badge>
  );
}

function formatRelative(ms: number | null | undefined): string {
  if (!ms) return '—';
  const delta = ms - Date.now();
  const abs = Math.abs(delta);
  const sec = Math.round(abs / 1000);
  const past = delta < 0;
  if (sec < 60) return past ? `${sec}s ago` : `in ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return past ? `${min}m ago` : `in ${min}m`;
  const hr = Math.round(min / 60);
  return past ? `${hr}h ago` : `in ${hr}h`;
}

export function OrchestratorView() {
  const navigate = useNavigate();
  const runsByThread = useOrchestratorStore((s) => s.runsByThread);
  const loading = useOrchestratorStore((s) => s.loading);
  const refreshing = useOrchestratorStore((s) => s.refreshing);
  const lastError = useOrchestratorStore((s) => s.lastError);
  const loadRuns = useOrchestratorStore((s) => s.loadRuns);
  const refresh = useOrchestratorStore((s) => s.refresh);

  const threadsByProject = useThreadStore((s) => s.threadsByProject);

  const findThread = useMemo(() => {
    const flat = new Map<string, { id: string; title: string; projectId: string }>();
    for (const list of Object.values(threadsByProject)) {
      for (const t of list)
        flat.set(t.id, { id: t.id, title: t.title ?? '', projectId: t.projectId });
    }
    return (threadId: string) => flat.get(threadId);
  }, [threadsByProject]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const runs = useMemo(() => {
    return Object.values(runsByThread).sort((a, b) => b.lastEventAtMs - a.lastEventAtMs);
  }, [runsByThread]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col" data-testid="orchestrator-view">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Activity className="icon-sm text-muted-foreground" /> Orchestrator queue
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Active runs claimed by the orchestrator. Updates in real time.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refresh()}
          disabled={refreshing}
          data-testid="orchestrator-refresh"
        >
          <RefreshCw className={cn('icon-xs', refreshing && 'animate-spin')} />
          <span className="ml-1">Refresh</span>
        </Button>
      </div>

      {lastError && (
        <div className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {lastError}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        {loading && runs.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="px-4 py-12 text-center text-xs text-muted-foreground">
            No runs in flight. The orchestrator picks up queued threads on the next tick.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {runs.map((run) => {
              const status = deriveStatus(run);
              const thread = findThread(run.threadId);
              const onOpen = () => {
                if (thread?.projectId) {
                  navigate(buildPath(`/projects/${thread.projectId}/threads/${run.threadId}`));
                }
              };
              return (
                <li
                  key={run.threadId}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-accent/30"
                  data-testid={`orchestrator-run-${run.threadId}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={onOpen}
                        disabled={!thread}
                        className={cn(
                          'truncate text-sm font-medium',
                          thread
                            ? 'cursor-pointer hover:underline'
                            : 'cursor-default text-muted-foreground',
                        )}
                        data-testid={`orchestrator-run-open-${run.threadId}`}
                      >
                        {thread?.title || run.threadId.slice(0, 12)}
                      </button>
                      <StatusBadge status={status} />
                      {run.attempt > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          attempt {run.attempt}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span className="font-mono">thread {run.threadId.slice(0, 8)}</span>
                      {run.pipelineRunId && (
                        <span className="font-mono">pipeline {run.pipelineRunId.slice(0, 8)}</span>
                      )}
                      <span>last event {formatRelative(run.lastEventAtMs)}</span>
                      {run.nextRetryAtMs && <span>retry {formatRelative(run.nextRetryAtMs)}</span>}
                    </div>
                    {run.lastError && (
                      <div className="mt-1 truncate text-xs text-destructive" title={run.lastError}>
                        {run.lastError}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
