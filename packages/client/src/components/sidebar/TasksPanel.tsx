import { Circle, CircleCheck, CircleDot, ListChecks } from 'lucide-react';

import { ScrollArea } from '@/components/ui/scroll-area';
import { useOpenSpecTasks } from '@/hooks/use-openspec-tasks';
import { cn } from '@/lib/utils';
import { useThreadStore } from '@/stores/thread-store';

interface ParsedTask {
  text: string;
  done: boolean;
}

interface ParsedGroup {
  title: string;
  tasks: ParsedTask[];
}

function parseTasks(content: string): ParsedGroup[] {
  const groups: ParsedGroup[] = [];
  let currentGroup: ParsedGroup | null = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trimStart();

    // ## header line → new group
    const headerMatch = trimmed.match(/^##\s+(.+)/);
    if (headerMatch) {
      currentGroup = { title: headerMatch[1], tasks: [] };
      groups.push(currentGroup);
      continue;
    }

    // - [x] or - [ ] → task item
    if (trimmed.startsWith('- [x]') || trimmed.startsWith('- [X]')) {
      const text = trimmed.slice(6).trim();
      if (!currentGroup) {
        currentGroup = { title: 'Tasks', tasks: [] };
        groups.push(currentGroup);
      }
      currentGroup.tasks.push({ text, done: true });
    } else if (trimmed.startsWith('- [ ]')) {
      const text = trimmed.slice(6).trim();
      if (!currentGroup) {
        currentGroup = { title: 'Tasks', tasks: [] };
        groups.push(currentGroup);
      }
      currentGroup.tasks.push({ text, done: false });
    }
  }

  return groups;
}

/** Extract a short label from a task, stripping the numeric prefix and markdown formatting */
function shortLabel(text: string): string {
  const stripped = text.replace(/^\d+(\.\d+)*\.?\s*/, '');
  return stripped.replace(/`/g, '');
}

/**
 * Find the first pending task — the one currently "in progress"
 * (i.e. all tasks before it are done, and it's the first `- [ ]`).
 */
function findActiveIndex(groups: ParsedGroup[]): { groupIdx: number; taskIdx: number } | null {
  for (let gi = 0; gi < groups.length; gi++) {
    for (let ti = 0; ti < groups[gi].tasks.length; ti++) {
      if (!groups[gi].tasks[ti].done) {
        return { groupIdx: gi, taskIdx: ti };
      }
    }
  }
  return null;
}

export function TasksPanel() {
  const arcId = useThreadStore((s) => s.activeThread?.arcId);
  const projectId = useThreadStore((s) => s.activeThread?.projectId);
  const threadStatus = useThreadStore((s) => s.activeThread?.status);

  const { content, progress, loading } = useOpenSpecTasks(arcId, projectId, threadStatus);

  const groups = content ? parseTasks(content) : [];
  const allDone = progress.total > 0 && progress.done === progress.total;
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const activeTask = !allDone ? findActiveIndex(groups) : null;

  if (!arcId) {
    return (
      <div
        data-testid="tasks-pane-empty"
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        No arc selected
      </div>
    );
  }

  if (loading && !content) {
    return (
      <div
        data-testid="tasks-pane-loading"
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        Loading tasks...
      </div>
    );
  }

  if (!content) {
    return (
      <div
        data-testid="tasks-pane-empty"
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        No tasks found
      </div>
    );
  }

  return (
    <div data-testid="tasks-pane" className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <ListChecks className="icon-base text-muted-foreground" />
        <span className="flex-1 text-sm font-medium">Tasks</span>
        <span
          data-testid="tasks-pane-progress"
          className={cn(
            'font-mono text-xs px-2 py-0.5 rounded-full',
            allDone
              ? 'bg-status-success/10 text-status-success/80'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {progress.done}/{progress.total}
        </span>
      </div>

      {/* Progress bar */}
      {progress.total > 0 && (
        <div className="shrink-0 px-4 py-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500 ease-out',
                allDone ? 'bg-status-success/80' : 'bg-status-info/80',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Task list */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 px-4 pb-4">
          {groups.map((group, gi) => (
            <div key={group.title}>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                {group.title}
              </div>
              <div className="space-y-1">
                {group.tasks.map((task, ti) => {
                  const isActive = activeTask?.groupIdx === gi && activeTask?.taskIdx === ti;
                  return (
                    <div
                      key={task.text}
                      data-testid={`tasks-pane-item-${gi}-${ti}`}
                      className={cn(
                        'flex items-start gap-2 rounded-md px-2 py-1.5',
                        isActive && 'bg-status-info/5',
                      )}
                    >
                      {task.done ? (
                        <CircleCheck className="icon-base mt-0.5 flex-shrink-0 text-status-success/80" />
                      ) : isActive ? (
                        <CircleDot className="icon-base mt-0.5 flex-shrink-0 animate-pulse text-status-info" />
                      ) : (
                        <Circle className="icon-base mt-0.5 flex-shrink-0 text-muted-foreground/40" />
                      )}
                      <span
                        className={cn(
                          'text-sm leading-relaxed',
                          task.done && 'text-muted-foreground line-through',
                          isActive && 'text-foreground font-medium',
                          !task.done && !isActive && 'text-muted-foreground',
                        )}
                      >
                        {shortLabel(task.text)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
