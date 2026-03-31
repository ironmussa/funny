import type { FileDiffSummary } from '@funny/shared';
import {
  Activity,
  Bot,
  Circle,
  CircleCheck,
  CircleDot,
  Cpu,
  FileCode,
  FilePlus,
  FileX,
  Loader2,
  PanelRightClose,
} from 'lucide-react';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { FileTree } from '@/components/FileTree';
import { formatInput } from '@/components/tool-cards/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTodoSnapshotsByAgent } from '@/hooks/use-todo-panel';
import type { TodoSnapshot } from '@/hooks/use-todo-panel';
import { api } from '@/lib/api';
import { parseDiffOld, parseDiffNew } from '@/lib/diff-parse';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useReviewPaneStore } from '@/stores/review-pane-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { ExpandedDiffDialog } from './tool-cards/ExpandedDiffDialog';

// ─── Constants ────────────────────────────────────────────

/** Stable empty Set so that referential equality is preserved across renders. */
const EMPTY_SET = new Set<string>();

// ─── Diff helpers ─────────────────────────────────────────

const fileStatusIcons: Record<string, typeof FileCode> = {
  added: FilePlus,
  modified: FileCode,
  deleted: FileX,
  renamed: FileCode,
};

// ─── Hooks ────────────────────────────────────────────────

interface RunningAgent {
  id: string;
  description: string;
  childToolCallCount: number;
}

/** Only returns active sub-agents (Task tool calls without output). */
function useRunningAgents(): RunningAgent[] {
  const prevRef = useRef<RunningAgent[]>([]);

  const agents = useThreadStore((s) => {
    const messages = s.activeThread?.messages;
    if (!messages) {
      if (prevRef.current.length === 0) return prevRef.current;
      prevRef.current = [];
      return prevRef.current;
    }

    const allToolCalls: {
      id: string;
      name: string;
      input: any;
      output?: string | null;
      parentToolCallId?: string;
    }[] = [];
    for (const msg of messages) {
      for (const tc of (msg.toolCalls ?? []) as any[]) {
        allToolCalls.push(tc);
      }
    }

    const running: RunningAgent[] = [];
    for (const tc of allToolCalls) {
      // Only Task tool calls = sub-agents, still running (no output)
      if (tc.name === 'Task' && !tc.output) {
        const parsed = formatInput(tc.input);
        const description =
          (parsed.description as string) ?? (parsed.prompt as string) ?? 'Sub-agent';
        const childCount = allToolCalls.filter((c) => c.parentToolCallId === tc.id).length;
        running.push({
          id: tc.id,
          description,
          childToolCallCount: childCount,
        });
      }
    }

    const prev = prevRef.current;
    if (
      prev.length === running.length &&
      running.every(
        (r, i) => r.id === prev[i].id && r.childToolCallCount === prev[i].childToolCallCount,
      )
    ) {
      return prev;
    }
    prevRef.current = running;
    return running;
  });

  return agents;
}

/**
 * Fetch ALL file paths touched by file-modifying tool calls (Write, Edit, NotebookEdit)
 * for the active thread. Uses a dedicated API endpoint that queries the database directly,
 * so it returns complete results regardless of message pagination limits.
 */
function useThreadTouchedPaths(): Set<string> {
  const threadId = useThreadStore((s) => s.activeThread?.id);
  const isRunning = useThreadStore((s) => s.activeThread?.status === 'running');
  const [paths, setPaths] = useState<Set<string>>(EMPTY_SET);
  const prevRef = useRef<Set<string>>(EMPTY_SET);
  const prevThreadIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Clear when switching threads
    if (threadId !== prevThreadIdRef.current) {
      prevThreadIdRef.current = threadId;
      setPaths(EMPTY_SET);
      prevRef.current = EMPTY_SET;
    }

    if (!threadId) return;

    let cancelled = false;

    const fetchPaths = async () => {
      const result = await api.getTouchedFiles(threadId);
      if (cancelled) return;
      if (result.isOk()) {
        const files = result.value.files;
        // Use stable EMPTY_SET for empty results to avoid unnecessary re-renders
        if (files.length === 0) {
          if (prevRef.current.size !== 0) {
            prevRef.current = EMPTY_SET;
            setPaths(EMPTY_SET);
          }
          return;
        }
        const newPaths = new Set(files);
        const prev = prevRef.current;
        // Stable reference check
        if (newPaths.size !== prev.size || ![...newPaths].every((p) => prev.has(p))) {
          prevRef.current = newPaths;
          setPaths(newPaths);
        }
      }
    };

    fetchPaths();

    // Re-fetch periodically while the thread is running to pick up new files
    if (isRunning) {
      const interval = setInterval(fetchPaths, 5000);
      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    }

    return () => {
      cancelled = true;
    };
  }, [threadId, isRunning]);

  return paths;
}

function useActivityFiles() {
  const threadId = useThreadStore((s) => s.activeThread?.id);
  const dirtySignal = useReviewPaneStore((s) => s.dirtySignal);
  const touchedPaths = useThreadTouchedPaths();
  const [files, setFiles] = useState<FileDiffSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [manualRefresh, setManualRefresh] = useState(0);
  const prevThreadIdRef = useRef(threadId);

  // Clear stale data immediately when switching threads
  useEffect(() => {
    if (threadId !== prevThreadIdRef.current) {
      prevThreadIdRef.current = threadId;
      setFiles([]);
      setLoading(!!threadId);
    }
  }, [threadId]);

  useEffect(() => {
    if (!threadId) {
      setFiles([]);
      return;
    }

    // No touched paths → no modified files to show; skip the diff API call entirely.
    // This prevents unnecessary loading flickers for idle threads.
    if (touchedPaths.size === 0) {
      setFiles([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      const result = await api.getDiffSummary(threadId);
      if (!cancelled && result.isOk()) {
        // Filter to only files this thread's agent actually touched
        const filtered = result.value.files.filter((f) => {
          // Match by basename suffix — tool calls use absolute paths,
          // diff summary uses relative paths from the repo root.
          for (const tp of touchedPaths) {
            if (tp.endsWith(`/${f.path}`) || tp === f.path) return true;
          }
          return false;
        });
        setFiles(filtered);
      }
      if (!cancelled) setLoading(false);
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [threadId, dirtySignal, manualRefresh, touchedPaths]);

  const refresh = useCallback(() => setManualRefresh((n) => n + 1), []);

  return { files, loading, refresh };
}

// ─── Sub-components ───────────────────────────────────────

function ActivitySection({
  title,
  testId,
  count,
  children,
}: {
  title: string;
  testId: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {count !== undefined && count > 0 && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {count}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function InlineTodoList({
  todos,
  progress,
}: {
  todos: { content: string; status: string; activeForm?: string }[];
  progress: { completed: number; total: number };
}) {
  const pct = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  const allDone = progress.completed === progress.total;

  return (
    <div className="mt-1.5 space-y-1.5">
      {/* Progress bar */}
      <div className="flex items-center gap-2">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500',
              allDone ? 'bg-status-success/80' : 'bg-status-info/80',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span
          className={cn(
            'font-mono text-[10px]',
            allDone ? 'text-status-success/80' : 'text-muted-foreground',
          )}
        >
          {progress.completed}/{progress.total}
        </span>
      </div>

      {/* Todo items */}
      <div className="space-y-1">
        {todos.map((todo, i) => (
          <div
            key={todo.content}
            data-testid={`activity-todo-${i}`}
            className="flex items-start gap-2"
          >
            {todo.status === 'completed' ? (
              <CircleCheck className="icon-sm mt-0.5 flex-shrink-0 text-status-success/80" />
            ) : todo.status === 'in_progress' ? (
              <CircleDot className="icon-sm mt-0.5 flex-shrink-0 animate-pulse text-status-info" />
            ) : (
              <Circle className="icon-sm mt-0.5 flex-shrink-0 text-muted-foreground/50" />
            )}
            <span
              className={cn(
                'text-xs leading-relaxed',
                todo.status === 'completed' && 'text-muted-foreground line-through',
                todo.status === 'in_progress' && 'font-medium text-foreground',
                todo.status === 'pending' && 'text-muted-foreground',
              )}
            >
              {todo.status === 'in_progress' ? todo.activeForm || todo.content : todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Card for a single agent (main or sub-agent) with optional inline todos. */
function AgentCard({
  testId,
  icon: Icon,
  label,
  isRunning,
  childToolCallCount,
  todoSnapshot,
}: {
  testId: string;
  icon: typeof Bot;
  label: string;
  isRunning: boolean;
  childToolCallCount?: number;
  todoSnapshot: TodoSnapshot | null;
}) {
  const { t } = useTranslation();

  return (
    <div data-testid={testId} className="rounded-md border border-border/50 px-2.5 py-2">
      {/* Agent header */}
      <div className="flex items-center gap-2">
        {isRunning && (
          <Loader2 className="icon-xs flex-shrink-0 animate-spin text-muted-foreground" />
        )}
        <Icon className="icon-sm flex-shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {label}
        </span>
        {childToolCallCount !== undefined && childToolCallCount > 0 && (
          <span className="flex-shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {childToolCallCount} {t('activity.tools', 'tools')}
          </span>
        )}
      </div>

      {/* Inline todos (if this agent has any) */}
      {todoSnapshot && (
        <InlineTodoList todos={todoSnapshot.todos} progress={todoSnapshot.progress} />
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="px-4 py-3 text-center text-xs italic text-muted-foreground/50">{message}</div>
  );
}

// ─── Main Component ───────────────────────────────────────

export function ActivityPane() {
  const { t } = useTranslation();

  // Agents & todos grouped by agent
  const runningAgents = useRunningAgents();
  const agentTodos = useTodoSnapshotsByAgent();
  const isThreadRunning = useThreadStore((s) => s.activeThread?.status === 'running');

  // Show main agent card when thread is running or when it has todos
  const showMainAgent = isThreadRunning || agentTodos.mainAgent !== null;
  const totalAgentCount = (showMainAgent ? 1 : 0) + runningAgents.length;

  // Modified files
  const { files, loading: filesLoading, refresh: refreshFiles } = useActivityFiles();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diffCache, setDiffCache] = useState<Map<string, string>>(new Map());
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null);

  const threadId = useThreadStore((s) => s.activeThread?.id);

  // Reset diff state when switching threads
  const prevMainThreadRef = useRef(threadId);
  useEffect(() => {
    if (threadId !== prevMainThreadRef.current) {
      prevMainThreadRef.current = threadId;
      setSelectedFile(null);
      setExpandedFile(null);
      setDiffCache(new Map());
      setLoadingDiff(null);
    }
  }, [threadId]);

  const basePath = useThreadStore((s) => {
    const wt = s.activeThread?.worktreePath;
    if (wt) return wt;
    const pid = s.activeThread?.projectId;
    if (!pid) return '';
    return useProjectStore.getState().projects.find((p) => p.id === pid)?.path ?? '';
  });

  const loadDiffForFile = useCallback(
    async (filePath: string) => {
      if (!threadId || diffCache.has(filePath)) return;
      const summary = files.find((s) => s.path === filePath);
      if (!summary) return;
      setLoadingDiff(filePath);
      const result = await api.getFileDiff(threadId, filePath, summary.staged);
      if (result.isOk()) {
        setDiffCache((prev) => new Map(prev).set(filePath, result.value.diff));
      }
      setLoadingDiff((prev) => (prev === filePath ? null : prev));
    },
    [threadId, diffCache, files],
  );

  useEffect(() => {
    if (expandedFile && !diffCache.has(expandedFile)) {
      loadDiffForFile(expandedFile);
    }
  }, [expandedFile]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRevertFile = useCallback(
    async (path: string) => {
      if (!threadId) return;
      const result = await api.revertFiles(threadId, [path]);
      if (result.isErr()) {
        toast.error(t('review.revertFailed', { message: result.error.message }));
      } else {
        toast.success(t('review.revertSuccess', { path, defaultValue: '{{path}} reverted' }));
        setDiffCache((prev) => {
          const next = new Map(prev);
          next.delete(path);
          return next;
        });
        refreshFiles();
      }
    },
    [threadId, t, refreshFiles],
  );

  const handleFileClick = useCallback((path: string) => {
    setSelectedFile(path);
    setExpandedFile(path);
  }, []);

  if (!threadId) {
    return (
      <div
        data-testid="activity-pane"
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        {t('activity.noThread', 'Select a thread to see activity')}
      </div>
    );
  }

  return (
    <div data-testid="activity-pane" className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-sidebar-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity className="icon-base text-muted-foreground" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-sidebar-foreground">
            {t('activity.title', 'Activity')}
          </h3>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => useUIStore.getState().setReviewPaneOpen(false)}
              className="text-muted-foreground"
              data-testid="activity-close"
            >
              <PanelRightClose className="icon-sm" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('common.close', 'Close')}</TooltipContent>
        </Tooltip>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-3">
          {/* Section 1: Agents (main + sub-agents, each with inline todos) */}
          <ActivitySection
            title={t('activity.agents', 'Agents')}
            testId="activity-agents"
            count={totalAgentCount}
          >
            {totalAgentCount > 0 ? (
              <div className="space-y-1.5 px-2 py-1.5">
                {/* Main agent */}
                {showMainAgent && (
                  <AgentCard
                    testId="activity-agent-main"
                    icon={Cpu}
                    label={t('activity.mainAgent', 'Main agent')}
                    isRunning={!!isThreadRunning}
                    todoSnapshot={agentTodos.mainAgent}
                  />
                )}

                {/* Sub-agents */}
                {runningAgents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    testId={`activity-agent-${agent.id}`}
                    icon={Bot}
                    label={agent.description}
                    isRunning={true}
                    childToolCallCount={agent.childToolCallCount}
                    todoSnapshot={agentTodos.bySubAgent.get(agent.id) ?? null}
                  />
                ))}
              </div>
            ) : (
              <EmptyState message={t('activity.noAgents', 'No running agents')} />
            )}
          </ActivitySection>

          {/* Section 2: Modified Files */}
          <ActivitySection
            title={t('activity.files', 'Modified Files')}
            testId="activity-files"
            count={files.length}
          >
            {files.length > 0 ? (
              <FileTree
                files={files}
                selectedFile={selectedFile}
                onFileClick={handleFileClick}
                onRevertFile={handleRevertFile}
                basePath={basePath}
                diffStatsSize="xs"
                fontSize="text-xs"
                testIdPrefix="activity-file"
              />
            ) : (
              <EmptyState
                message={
                  filesLoading
                    ? t('activity.loadingFiles', 'Loading...')
                    : t('activity.noFiles', 'No modified files')
                }
              />
            )}
          </ActivitySection>
        </div>
      </ScrollArea>

      {/* Expanded diff dialog */}
      {(() => {
        const expandedSummary = expandedFile
          ? files.find((s) => s.path === expandedFile)
          : undefined;
        const expandedDiffContent = expandedFile ? diffCache.get(expandedFile) : undefined;
        const ExpandedIcon = expandedSummary
          ? fileStatusIcons[expandedSummary.status] || FileCode
          : FileCode;
        return (
          <ExpandedDiffDialog
            open={!!expandedFile}
            onOpenChange={(open) => {
              if (!open) setExpandedFile(null);
            }}
            filePath={expandedSummary?.path || ''}
            oldValue={expandedDiffContent ? parseDiffOld(expandedDiffContent) : ''}
            newValue={expandedDiffContent ? parseDiffNew(expandedDiffContent) : ''}
            icon={ExpandedIcon}
            loading={loadingDiff === expandedFile}
            description={
              expandedSummary
                ? t('review.diffFor', {
                    file: expandedSummary.path,
                    defaultValue: `Diff for ${expandedSummary.path}`,
                  })
                : undefined
            }
            files={files}
            onFileSelect={(path) => {
              setSelectedFile(path);
              setExpandedFile(path);
            }}
            diffCache={diffCache}
            loadingDiffPath={loadingDiff}
            onRevertFile={handleRevertFile}
            basePath={basePath}
          />
        );
      })()}
    </div>
  );
}
